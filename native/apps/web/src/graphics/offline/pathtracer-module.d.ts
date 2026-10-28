// Select the pinned official ESM build in both browser and Bun; avoid its legacy CJS entry.
declare module "three-gpu-pathtracer/build/index.module.js" {
  export * from "three-gpu-pathtracer";
}
