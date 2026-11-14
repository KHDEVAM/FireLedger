import { tok } from '../colors';
import { downloadBlob } from './csv';

/** Standalone SVG text of a chart, with a solid background. */
export function svgText(svg: SVGSVGElement, background = tok('--surface')): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const vb = svg.viewBox.baseVal;
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', String(vb.width));
  bg.setAttribute('height', String(vb.height));
  bg.setAttribute('fill', background);
  clone.insertBefore(bg, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load image ${src.slice(0, 60)}`));
    img.src = src;
  });
}

export async function svgToCanvas(svg: SVGSVGElement, scale = 2, background?: string): Promise<HTMLCanvasElement> {
  const vb = svg.viewBox.baseVal;
  const url = URL.createObjectURL(new Blob([svgText(svg, background)], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vb.width * scale);
    canvas.height = Math.round(vb.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadPng(svg: SVGSVGElement, name: string): Promise<void> {
  const canvas = await svgToCanvas(svg);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (blob) downloadBlob(blob, name);
}

export function downloadSvg(svg: SVGSVGElement, name: string): void {
  downloadBlob(new Blob([svgText(svg)], { type: 'image/svg+xml;charset=utf-8' }), name);
}
