import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { buildGhostRoute, type GhostRouteMode, type RouteFrames } from "./ghost-route-data";

/** A route and all takeoff boxes in two cached draws, with screen-space widths for readable distant markers. */
export class GhostRoute {
  readonly root = new THREE.Group();
  readonly path: LineSegments2;
  readonly markers: LineSegments2;
  readonly jumpCount: number;

  constructor(data: RouteFrames, color: THREE.ColorRepresentation, readonly mode: GhostRouteMode) {
    const route = buildGhostRoute(data, mode);
    this.jumpCount = route.jumpTicks.length;
    this.root.name = "ghost-route";
    this.path = this.lines(route.segments, color, 2.5, 0.85);
    const boxes = new Float32Array(this.jumpCount * 12 * 6);
    // Small wire boxes centred on the takeoff, just above the ground. White regardless of route/ghost colour.
    const corners = [[-6,-1,-6],[6,-1,-6],[6,-1,6],[-6,-1,6],[-6,2,-6],[6,2,-6],[6,2,6],[-6,2,6]];
    const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    let at = 0;
    for (let j = 0; j < this.jumpCount; j++) for (const edge of edges) for (const k of edge) {
      for (let axis = 0; axis < 3; axis++) boxes[at++] = route.jumps[j * 3 + axis] + corners[k][axis];
    }
    this.markers = this.lines(boxes, 0xffffff, 2, 0.95);
    this.path.name = "ghost-route-path";
    this.markers.name = "ghost-route-takeoffs";
    this.root.add(this.path, this.markers);
  }

  private lines(positions: Float32Array, color: THREE.ColorRepresentation, width: number, opacity: number): LineSegments2 {
    const geometry = new LineSegmentsGeometry();
    // Empty LineSegmentsGeometry has invalid bounds in some Three releases; a hidden degenerate segment is harmless.
    geometry.setPositions(positions.length ? positions : new Float32Array(6));
    const material = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthWrite: false, depthTest: true, toneMapped: false });
    const mesh = new LineSegments2(geometry, material);
    mesh.visible = positions.length > 0;
    mesh.raycast = () => {};
    return mesh;
  }
  setColor(color: THREE.ColorRepresentation): void { this.path.material.color.set(color); }
  dispose(): void {
    this.root.removeFromParent();
    for (const mesh of [this.path, this.markers]) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
}
