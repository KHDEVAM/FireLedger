import maplibregl, { type GeoJSONSource, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ageColors, tok } from '../colors';
import type { Hotspot } from '../types';

/** OpenStreetMap-based vector basemap (OpenFreeMap) - see SOURCES.md */
const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
/** NASA GIBS true-color imagery (VIIRS NOAA-20 corrected reflectance) - see SOURCES.md */
const gibsTiles = (date: string) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;

type Ring = [number, number][];
type DrawMode = 'rect' | 'poly';

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export function ageClass(ageH: number): number {
  return ageH < 6 ? 0 : ageH < 24 ? 1 : ageH < 48 ? 2 : 3;
}

export class FireMap {
  readonly map: MlMap;
  readonly ready: Promise<void>;
  private draw: { mode: DrawMode; pts: Ring; done: (ring: Ring) => void; cancel: () => void } | null = null;

  constructor(el: HTMLElement, bbox: [number, number, number, number]) {
    this.map = new maplibregl.Map({
      container: el,
      style: BASEMAP_STYLE,
      bounds: bbox,
      fitBoundsOptions: { padding: 20 },
      attributionControl: { compact: true },
      // needed to copy the map into the PDF briefing
      preserveDrawingBuffer: true,
    } as maplibregl.MapOptions);
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));
    this.ready = new Promise((resolve) => this.map.on('load', () => (this.setup(), resolve())));
  }

  private setup(): void {
    const m = this.map;
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    m.addSource('gibs', {
      type: 'raster',
      tiles: [gibsTiles(yesterday)],
      tileSize: 256,
      maxzoom: 9,
      attribution: 'Imagery: NASA GIBS / EOSDIS',
    });
    m.addLayer({ id: 'gibs', type: 'raster', source: 'gibs', layout: { visibility: 'none' } });
    for (const id of ['density', 'aoi', 'wind', 'nrt', 'sketch']) m.addSource(id, { type: 'geojson', data: empty() });
    m.addLayer({ id: 'density', type: 'fill', source: 'density', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.75, 8, 0.45, 10, 0.3] } });
    m.addLayer({ id: 'aoi', type: 'line', source: 'aoi', paint: { 'line-color': tok('--fl-satellite-blue'), 'line-width': 2.5 } });
    m.addLayer({ id: 'wind', type: 'line', source: 'wind', paint: { 'line-color': tok('--fl-ledger-navy'), 'line-width': 3, 'line-dasharray': [1.5, 1] } });
    m.addLayer({
      id: 'nrt',
      type: 'circle',
      source: 'nrt',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 7],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': tok('--fl-paper'),
        'circle-stroke-width': 1.5,
      },
    });
    m.addLayer({ id: 'sketch', type: 'line', source: 'sketch', paint: { 'line-color': tok('--fl-signal-blue'), 'line-width': 2, 'line-dasharray': [2, 1] } });
    m.addLayer({ id: 'sketch-pts', type: 'circle', source: 'sketch', paint: { 'circle-radius': 4, 'circle-color': tok('--fl-signal-blue') } });

    m.on('click', (e) => this.onClick(e));
    m.on('mousemove', (e) => this.onMove(e));
    m.on('dblclick', (e) => {
      if (this.draw?.mode === 'poly') {
        e.preventDefault();
        this.finishDraw();
      }
    });
    m.getContainer().addEventListener('keydown', (ev) => {
      if (!this.draw) return;
      if (ev.key === 'Escape') this.cancelDraw();
      if (ev.key === 'Enter' && this.draw.mode === 'poly') this.finishDraw();
    });
  }

  private src(id: string): GeoJSONSource {
    return this.map.getSource(id) as GeoJSONSource;
  }

  setDensity(cells: [number, number][], size: number, totals: ArrayLike<number>, color: (v: number) => string): void {
    const features: GeoJSON.Feature[] = [];
    cells.forEach(([lon, lat], i) => {
      const v = totals[i];
      if (!(v > 0)) return;
      features.push({
        type: 'Feature',
        properties: { v, color: color(v) },
        geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]] },
      });
    });
    this.src('density').setData({ type: 'FeatureCollection', features });
  }

  setAoi(ring: Ring | null): void {
    this.src('aoi').setData(ring ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } } : empty());
  }

  setNrt(hotspots: Hotspot[]): void {
    const colors = ageColors();
    // oldest first so the most recent detections are drawn on top
    const sorted = [...hotspots].sort((a, b) => b.ageH - a.ageH);
    this.src('nrt').setData({
      type: 'FeatureCollection',
      features: sorted.map((h) => ({
        type: 'Feature',
        properties: { color: colors[ageClass(h.ageH)], frp: h.frp, sat: h.sat, time: h.time },
        geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
      })),
    });
  }

  /** Indicative downwind vector from a point. */
  setWind(line: Ring | null): void {
    this.src('wind').setData(line ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } } : empty());
  }

  setVisible(layer: 'density' | 'nrt' | 'gibs', on: boolean): void {
    this.map.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
  }

  fit(bbox: [number, number, number, number]): void {
    this.map.fitBounds(bbox, { padding: 30, maxZoom: 11, duration: 400 });
  }

  snapshot(): string {
    return this.map.getCanvas().toDataURL('image/png');
  }

  /* ---------- drawing: click to add corners / vertices ---------- */

  startDraw(mode: DrawMode, done: (ring: Ring) => void, cancel: () => void): void {
    this.cancelDraw();
    this.draw = { mode, pts: [], done, cancel };
    this.map.doubleClickZoom.disable();
    this.map.getCanvas().style.cursor = 'crosshair';
    // keyboard focus for Enter / Escape, without scrolling the page under the pointer
    this.map.getCanvas().focus({ preventScroll: true });
  }

  cancelDraw(): void {
    if (!this.draw) return;
    const { cancel } = this.draw;
    this.endDraw();
    cancel();
  }

  private endDraw(): void {
    this.draw = null;
    this.src('sketch').setData(empty());
    this.map.getCanvas().style.cursor = '';
    setTimeout(() => this.map.doubleClickZoom.enable(), 300);
  }

  private finishDraw(): void {
    if (!this.draw) return;
    const { pts, done, mode } = this.draw;
    if (mode === 'poly' && pts.length < 3) return;
    this.endDraw();
    done(pts);
  }

  private onClick(e: MapMouseEvent): void {
    if (!this.draw) return;
    const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    const d = this.draw;
    if (d.mode === 'rect') {
      if (!d.pts.length) {
        d.pts.push(p);
        this.sketch([p]);
      } else {
        const [a] = d.pts;
        const done = d.done;
        this.endDraw();
        done(rect(a, p));
      }
      return;
    }
    // polygon: clicking near the first vertex closes it
    if (d.pts.length >= 3) {
      const first = this.map.project(d.pts[0] as [number, number]);
      if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) return this.finishDraw();
    }
    const last = d.pts[d.pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) d.pts.push(p);
    this.sketch(d.pts);
  }

  private onMove(e: MapMouseEvent): void {
    if (!this.draw || !this.draw.pts.length) return;
    const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    if (this.draw.mode === 'rect') this.sketch([...rect(this.draw.pts[0], p), this.draw.pts[0]]);
    else this.sketch([...this.draw.pts, p]);
  }

  private sketch(pts: Ring): void {
    const features: GeoJSON.Feature[] = pts.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }));
    if (pts.length > 1) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
    this.src('sketch').setData({ type: 'FeatureCollection', features });
  }
}

function rect(a: [number, number], b: [number, number]): Ring {
  const w = Math.min(a[0], b[0]);
  const e = Math.max(a[0], b[0]);
  const s = Math.min(a[1], b[1]);
  const n = Math.max(a[1], b[1]);
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ];
}
