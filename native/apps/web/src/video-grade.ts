// Display-only filtering of the game canvas and its frozen backdrop. No extra Three render target, changes to UI
// colours or replay data. Screen recordings include this view; the replay export renderer retains its own colours.
import { neutralVideo, videoGrade, videoTransfer, type VideoGrade } from "./video-settings";

const SVG = "http://www.w3.org/2000/svg";
const FILTER_ID = "bunnyhop-video-grade";

export class CanvasVideoGrade {
  private svg: SVGSVGElement | null = null;
  private funcs: SVGFEFuncRElement[] = [];
  private saturation: SVGFEColorMatrixElement | null = null;
  private last = "";

  set(raw: VideoGrade): void {
    const value = videoGrade(raw);
    const key = JSON.stringify(value);
    if (key === this.last) return;
    this.last = key;
    if (neutralVideo(value)) {
      document.documentElement.style.removeProperty("--video-grade");
      return;
    }
    this.init();
    const transfer = videoTransfer(value);
    for (const f of this.funcs) {
      f.setAttribute("amplitude", String(transfer.amplitude));
      f.setAttribute("exponent", String(transfer.exponent));
    }
    this.saturation!.setAttribute("values", String(transfer.saturation));
    document.documentElement.style.setProperty("--video-grade", `url("#${FILTER_ID}")`);
  }

  private init(): void {
    if (this.svg) return;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:fixed;pointer-events:none";
    const defs = document.createElementNS(SVG, "defs");
    const filter = document.createElementNS(SVG, "filter");
    filter.id = FILTER_ID;
    filter.setAttribute("x", "0");
    filter.setAttribute("y", "0");
    filter.setAttribute("width", "100%");
    filter.setAttribute("height", "100%");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const component = document.createElementNS(SVG, "feComponentTransfer");
    for (const channel of ["R", "G", "B"] as const) {
      const func = document.createElementNS(SVG, `feFunc${channel}`) as SVGFEFuncRElement;
      func.setAttribute("type", "gamma");
      func.setAttribute("offset", "0");
      component.append(func);
      this.funcs.push(func);
    }
    const saturation = document.createElementNS(SVG, "feColorMatrix");
    saturation.setAttribute("type", "saturate");
    filter.append(component, saturation);
    defs.append(filter);
    svg.append(defs);
    document.body.append(svg);
    this.svg = svg;
    this.saturation = saturation;
  }
}
