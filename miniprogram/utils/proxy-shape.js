// Collision-proxy sizing: the proxy is a box, NOT the visual triangle mesh.
// Both the cannon-es dynamic body (utils/physics.js) and the xr-frame
// cube-shape (components/xr-viewer/index.wxml) must derive their size from
// this single function so the two never drift out of sync.
//
// Phase-2 TODO: replace this whole box-proxy approach with a precomputed
// convex hull shipped alongside the per-user generated GLB, computed by the
// cloud pipeline rather than guessed here.

// Phase-1 fallback: hand-measured half-extents for assets/sample.glb (the
// bundled Khronos "Duck" sample). It's unconfirmed whether xr-frame exposes a
// loaded glTF node's bounding box programmatically (verify against DevTools
// autocomplete/type defs); until confirmed, this hardcoded box is the source
// of truth.
const FALLBACK_HALF_EXTENTS = { x: 0.4, y: 0.6, z: 0.4 };

function getProxyHalfExtents(modelHandle) {
  if (modelHandle && typeof modelHandle.getBoundingBox === 'function') {
    // Speculative path: only taken if a bounding-box accessor turns out to
    // exist on the loaded glTF/node handle. Left here as the natural place to
    // wire that in once confirmed; falls through to the fallback otherwise.
    const box = modelHandle.getBoundingBox();
    if (box && box.max && box.min) {
      return {
        x: (box.max.x - box.min.x) / 2,
        y: (box.max.y - box.min.y) / 2,
        z: (box.max.z - box.min.z) / 2,
      };
    }
  }
  return FALLBACK_HALF_EXTENTS;
}

module.exports = {
  getProxyHalfExtents,
  FALLBACK_HALF_EXTENTS,
};
