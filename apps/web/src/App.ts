import { compressFile, downloadOutput } from "./api/client.js";
import { createFileDropzone } from "./components/FileDropzone.js";
import { createJobProgress, setProgress } from "./components/JobProgress.js";
import { createProfileSelector } from "./components/ProfileSelector.js";
import { createResultSummary, renderError, renderResult } from "./components/ResultSummary.js";
import type { CompressionProfileName } from "./profiles.js";

// NOTE: the page editor, the fill surface and PDF.js stay behind a dynamic
// import so the compressor shell never eagerly loads them (SC1). Do not add
// a static import of the editor, the filler or pdfjs-dist here.
type PageEditorModule = typeof import("./components/PageEditor.js");
type FormFillerModule = typeof import("./components/FormFiller.js");

export function mountApp(root: HTMLElement): void {
  mountCompressor(root);
}

function mountCompressor(root: HTMLElement): void {
  let selectedFile: File | undefined;
  let selectedProfile: CompressionProfileName = "balanced";
  let currentController: AbortController | undefined;
  let compressObjectUrl: string | null = null;
  let mounted = true;

  function revokeCompressUrl(): void {
    if (compressObjectUrl) {
      try {
        URL.revokeObjectURL(compressObjectUrl);
      } catch {
        // Best effort.
      }
      compressObjectUrl = null;
    }
  }

  const title = document.createElement("h1");
  title.textContent = "PDF Compressor";

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = "Compress PDFs locally. Nothing is uploaded to a third-party service.";

  const progress = createJobProgress();
  const result = createResultSummary();
  const button = document.createElement("button");
  button.className = "button";
  button.textContent = "Compress";
  button.disabled = true;

  const cancelButton = document.createElement("button");
  cancelButton.className = "button button--secondary";
  cancelButton.textContent = "Cancel";
  cancelButton.disabled = true;

  const editorButton = document.createElement("button");
  editorButton.className = "button button--secondary";
  editorButton.textContent = "Edit pages";
  editorButton.addEventListener("click", () => {
    mounted = false;
    currentController?.abort();
    revokeCompressUrl();
    void mountEditor(root);
  });

  const fillButton = document.createElement("button");
  fillButton.className = "button button--secondary";
  fillButton.textContent = "Fill and sign";
  fillButton.addEventListener("click", () => {
    mounted = false;
    currentController?.abort();
    revokeCompressUrl();
    void mountFormFiller(root);
  });

  const dropzone = createFileDropzone((file) => {
    selectedFile = file;
    button.disabled = false;
    setProgress(progress, `${file.name} selected`);
    revokeCompressUrl();
    result.innerHTML = "";
  });

  const profiles = createProfileSelector((profile) => {
    selectedProfile = profile;
  });

  button.addEventListener("click", async () => {
    if (!selectedFile) return;
    currentController = new AbortController();
    const signal = currentController.signal;
    button.disabled = true;
    cancelButton.disabled = false;
    setProgress(progress, "Compressing locally...");
    revokeCompressUrl();
    result.innerHTML = "";

    try {
      const response = await compressFile(selectedFile, selectedProfile, signal);
      if (response.ok && response.summary && response.downloadUrl) {
        // The /api/outputs download requires the session cookie plus the
        // launch token, which a plain anchor cannot send. Fetch it with
        // credentials and expose a local object URL to the user instead.
        const blob = await downloadOutput(response.downloadUrl, signal);
        if (!mounted || signal.aborted) return;
        revokeCompressUrl();
        compressObjectUrl = URL.createObjectURL(blob);
        renderResult(result, response.summary, compressObjectUrl, "compressed.pdf");
        setProgress(progress, "Done");
      } else {
        renderError(result, response.message ?? "Compression failed.");
        setProgress(progress, "Could not compress this PDF");
      }
    } catch (error) {
      if (!mounted) return;
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      renderError(result, cancelled ? "Compression cancelled." : "Compression failed.");
      setProgress(progress, cancelled ? "Cancelled" : "Could not compress this PDF");
    } finally {
      currentController = undefined;
      if (mounted) {
        button.disabled = false;
        cancelButton.disabled = true;
      }
    }
  });

  cancelButton.addEventListener("click", () => {
    currentController?.abort();
  });

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(button, cancelButton, editorButton, fillButton);

  root.replaceChildren(title, subtitle, dropzone, profiles, actions, progress, result);
}

async function mountEditor(root: HTMLElement): Promise<void> {
  const loading = document.createElement("p");
  loading.className = "progress";
  loading.setAttribute("role", "status");
  loading.textContent = "Opening the page editor...";
  root.replaceChildren(loading);
  try {
    const module: PageEditorModule = await import("./components/PageEditor.js");
    if (!root.contains(loading)) return;
    // Keep the live handle so leaving the editor can release PDF.js
    // documents, canvases, object URLs, observers, and queued work before
    // the compressor DOM replaces the editor. Declared before the callback
    // so onExit never hits a temporal-dead-zone, and cleared before destroy
    // so a repeated exit cannot destroy twice.
    let liveEditor: ReturnType<PageEditorModule["createPageEditor"]> | undefined;
    const handleExit = (): void => {
      const live = liveEditor;
      liveEditor = undefined;
      try {
        live?.destroy();
      } finally {
        mountCompressor(root);
      }
    };
    const editor = module.createPageEditor({ onExit: handleExit });
    liveEditor = editor;
    root.replaceChildren(editor.element);
  } catch {
    renderError(root, "The page editor could not be opened. Go back and try again.");
    const back = document.createElement("button");
    back.className = "button button--secondary";
    back.textContent = "Back to compressor";
    back.addEventListener("click", () => mountCompressor(root));
    root.append(back);
  }
}

async function mountFormFiller(root: HTMLElement): Promise<void> {
  const loading = document.createElement("p");
  loading.className = "progress";
  loading.setAttribute("role", "status");
  loading.textContent = "Opening the form filler...";
  root.replaceChildren(loading);
  try {
    const module: FormFillerModule = await import("./components/FormFiller.js");
    if (!root.contains(loading)) return;
    // Same live-handle discipline as the page editor: the filler owns a
    // document, a page canvas, object URLs and window listeners that must be
    // released before the compressor DOM replaces it.
    let liveFiller: ReturnType<FormFillerModule["createFormFiller"]> | undefined;
    const handleExit = (): void => {
      const live = liveFiller;
      liveFiller = undefined;
      try {
        live?.destroy();
      } finally {
        root.classList.remove("app--fill");
        mountCompressor(root);
      }
    };
    const filler = module.createFormFiller({ onExit: handleExit });
    liveFiller = filler;
    // R37: only the fill surface escapes the shell width, via this class.
    root.classList.add("app--fill");
    root.replaceChildren(filler.element);
  } catch {
    root.classList.remove("app--fill");
    renderError(root, "The form filler could not be opened. Go back and try again.");
    const back = document.createElement("button");
    back.className = "button button--secondary";
    back.textContent = "Back to compressor";
    back.addEventListener("click", () => mountCompressor(root));
    root.append(back);
  }
}
