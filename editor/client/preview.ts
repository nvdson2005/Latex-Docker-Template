import { getDocument, GlobalWorkerOptions, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export interface Preview {
  show(revision: string): Promise<void>;
}

type Page = { element: HTMLElement; pdf: PDFPageProxy; height: number; rendered: boolean };
type DocumentView = {
  revision: string;
  zoom: number;
  pages: Page[];
  observer: IntersectionObserver;
  task: ReturnType<typeof getDocument>;
};
const assetRoot = '/pdfjs/';
const zoomLevels = [50, 65, 80, 100, 125, 150, 175, 200];

export function mountPreview(root: HTMLElement): Preview {
  root.innerHTML = `
    <div class="pdf-tools" hidden>
      <button type="button" aria-label="Zoom out">−</button>
      <output aria-label="PDF zoom">100%</output>
      <button type="button" aria-label="Zoom in">+</button>
    </div>
    <p class="pdf-message" role="status">Compile the project to preview the PDF.</p>
    <div class="pdf-scroll" tabindex="0" aria-label="PDF pages"></div>
  `;
  const toolbar = root.querySelector<HTMLElement>('.pdf-tools')!;
  const [zoomOut, zoomIn] = toolbar.querySelectorAll('button');
  const zoomLabel = toolbar.querySelector('output')!;
  const message = root.querySelector<HTMLElement>('.pdf-message')!;
  const scroll = root.querySelector<HTMLElement>('.pdf-scroll')!;
  let request = 0;
  let requestedRevision: string | undefined;
  let zoomIndex = zoomLevels.indexOf(100);
  let visible: DocumentView | undefined;
  let pending: ReturnType<typeof getDocument> | undefined;

  function anchor() {
    const pages = visible?.pages ?? [];
    let index = pages.findLastIndex(({ element }) => element.offsetTop <= scroll.scrollTop);
    index = Math.max(0, index);
    const page = pages[index];
    return {
      index,
      offset: page ? Math.max(0, scroll.scrollTop - page.element.offsetTop) : 0,
      left: scroll.scrollLeft,
    };
  }

  async function draw(page: Page, zoom: number): Promise<void> {
    if (page.rendered) return;
    page.rendered = true;
    const viewport = page.pdf.getViewport({ scale: zoom / 100 });
    const resolution = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(viewport.width, viewport.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width * resolution));
    canvas.height = Math.max(1, Math.ceil(viewport.height * resolution));
    await page.pdf.render({
      canvas, viewport, transform: [resolution, 0, 0, resolution, 0, 0],
    }).promise;
    page.element.append(canvas);
  }

  function destroy(task: ReturnType<typeof getDocument>): void {
    void task.destroy().catch(() => {});
  }

  async function show(revision: string): Promise<void> {
    requestedRevision = revision;
    const generation = ++request;
    const zoom = zoomLevels[zoomIndex];
    if (pending) destroy(pending);
    if (!visible) message.textContent = 'Loading PDF…';

    const task = getDocument({
      url: '/api/pdf?revision=' + encodeURIComponent(revision),
      cMapUrl: assetRoot + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: assetRoot + 'standard_fonts/',
      iccUrl: assetRoot + 'iccs/',
      wasmUrl: assetRoot + 'wasm/',
    });
    pending = task;
    try {
      const pdf = await task.promise;
      if (generation !== request) return;
      const stack = document.createElement('div');
      stack.className = 'pdf-pages';
      stack.dataset.revision = revision;
      const pages = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index): Promise<Page> => {
        const page = await pdf.getPage(index + 1);
        const viewport = page.getViewport({ scale: zoom / 100 });
        const element = document.createElement('div');
        element.className = 'pdf-page';
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', 'PDF page ' + (index + 1));
        element.style.width = viewport.width + 'px';
        element.style.height = viewport.height + 'px';
        return { element, pdf: page, height: viewport.height, rendered: false };
      }));
      if (generation !== request) return;
      stack.append(...pages.map(({ element }) => element));

      // Keep the current document interactive during loading and take its latest reading position.
      let position = anchor();
      let index = Math.min(position.index, pages.length - 1);
      while (!pages[index].rendered) {
        await draw(pages[index], zoom);
        if (generation !== request) return;
        position = anchor();
        index = Math.min(position.index, pages.length - 1);
      }

      const pageByElement = new Map(pages.map((page) => [page.element, page]));
      const observer = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const page = pageByElement.get(entry.target as HTMLElement);
          if (!page) continue;
          observer.unobserve(entry.target);
          void draw(page, zoom).catch(() => {
            if (visible?.task !== task) return;
            page.element.textContent = 'Could not render this page.';
          });
        }
      }, { root: scroll, rootMargin: '200px' });

      const previous = visible;
      visible = { revision, zoom, pages, observer, task };
      pending = undefined;
      previous?.observer.disconnect();
      if (previous) destroy(previous.task);
      scroll.replaceChildren(stack);
      toolbar.hidden = false;
      message.textContent = '';
      zoomLabel.textContent = zoom + '%';
      zoomOut.disabled = zoomIndex === 0;
      zoomIn.disabled = zoomIndex === zoomLevels.length - 1;
      const ratio = zoom / (previous?.zoom ?? zoom);
      scroll.scrollTop = pages[index].element.offsetTop + Math.min(position.offset * ratio, Math.max(0, pages[index].height - 1));
      scroll.scrollLeft = position.left * ratio;
      pages.forEach(({ element, rendered }) => { if (!rendered) observer.observe(element); });
    } catch (error) {
      if (generation !== request) return;
      pending = undefined;
      destroy(task);
      const detail = error instanceof Error ? error.message : String(error);
      message.textContent = 'Could not display the PDF. ' + detail;
      if (visible) {
        zoomIndex = zoomLevels.indexOf(visible.zoom);
        zoomOut.disabled = zoomIndex === 0;
        zoomIn.disabled = zoomIndex === zoomLevels.length - 1;
      }
    }
  }

  function changeZoom(step: number): void {
    const next = zoomIndex + step;
    if (!requestedRevision || next < 0 || next >= zoomLevels.length) return;
    zoomIndex = next;
    void show(requestedRevision);
  }

  zoomOut.addEventListener('click', () => changeZoom(-1));
  zoomIn.addEventListener('click', () => changeZoom(1));
  return { show };
}
