const { createPhysicsWorld, stepWorld } = require('../../utils/physics.js');
const { getProxyHalfExtents } = require('../../utils/proxy-shape.js');

const FIXED_DT = 1 / 60;
// Ceiling on a single frame's delta time, so that if the mini program is
// backgrounded (app suspension) and onTick doesn't fire for a while, we don't
// try to catch up with thousands of physics steps in one frame and freeze
// the UI. Any delta larger than this is simply clamped down to it.
const MAX_FRAME_DT = 0.25;

const DROP_START_POSITION = { x: 0, y: 2, z: 0 };

// XYZ-order quaternion -> Euler degrees, used only as a fallback if the
// xr-frame node turns out to expose Euler `.rotation` rather than a
// `.quaternion` setter -- see _syncModelTransform.
function quaternionToEulerDegrees(q) {
  const RAD_TO_DEG = 180 / Math.PI;
  const { x, y, z, w } = q;

  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);

  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);

  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);

  return {
    x: roll * RAD_TO_DEG,
    y: pitch * RAD_TO_DEG,
    z: yaw * RAD_TO_DEG,
  };
}

// Tap-to-jump tuning (upward + randomized horizontal impulse, applied as a
// direct velocity delta on the cannon-es body -- see onTouchModel).
const TAP_UPWARD_VELOCITY = 5;
const TAP_HORIZONTAL_SPREAD = 2;

Component({
  properties: {
    width: Number,
    height: Number,
    renderWidth: Number,
    renderHeight: Number,
  },

  data: {
    ready: false,
  },

  lifetimes: {
    detached() {
      this._accumulator = 0;
      this._lastTickTime = null;
      this.scene = null;
      this.world = null;
      this.dynamicBody = null;
      this.modelNode = null;
    },
  },

  methods: {
    // Confirmed real event (bind:gltf-loaded on <xr-gltf>) -- fires once the
    // glTF asset has actually finished loading and is attached to this node.
    // Phase 2 TODO: this is a natural place to hide a loading spinner / hand
    // off to onModelReady in the page once a real capture flow exists.
    onGltfLoaded() {
      console.log('[xr-viewer] model loaded');
    },

    onSceneReady(e) {
      // Phase 2 TODO: the GLB source is currently the hardcoded local
      // "/assets/sample.glb" declared in index.wxml's xr-asset-load. Once
      // photo-to-3D generation exists, plumb a `properties.modelSrc` (a
      // per-session cloud-storage fileID/URL) from the page down into the
      // WXML's `src` instead -- asset-id "toy-model" and everything below
      // that references it can stay the same.
      this.scene = e.detail.value;
      this._accumulator = 0;
      this._lastTickTime = null;

      // The node whose transform we drive every tick from the cannon-es body,
      // via node.setAttribute(name, "x y z") -- the same string-attribute
      // format WXML itself uses for position/rotation, going through the
      // framework's own attribute-parsing path rather than the "transform"
      // component's internal (dirty-flag/typed-array-backed) fields.
      this.modelNode = this.scene.getElementById('model-node');

      // No scale is applied to the glTF here -- confirmed via live
      // inspection (getComponent('gltf')._subRoots[0].getComponent(
      // 'transform')._scale) that xr-frame's <xr-gltf> loader already
      // reconstructs the GLB's own node hierarchy internally, including its
      // root node's baked-in 0.01 corrective `matrix` scale, automatically.
      // An earlier attempt applied an ADDITIONAL 0.01 on top of this on the
      // outer node, compounding to 0.01 x 0.01 = 0.0001 total -- a duck
      // rendered at ~1.5cm, far too small to see at any distance. That was
      // the actual bug: not a missing scale, but a doubled one.

      const halfExtents = getProxyHalfExtents(null);
      const { world, dynamicBody } = createPhysicsWorld({
        startPosition: DROP_START_POSITION,
        halfExtents,
      });
      this.world = world;
      this.dynamicBody = dynamicBody;

      // Snapshot for reset().
      this._initialBodyState = {
        position: { ...DROP_START_POSITION },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
      };

      this.data.ready = true;
      this.triggerEvent('modelready');
    },

    onTick(e) {
      if (!this.world || !this.dynamicBody || !this.modelNode) {
        return;
      }

      const now = (e.detail && e.detail.time) || Date.now() / 1000;
      if (this._lastTickTime === null) {
        this._lastTickTime = now;
        return;
      }

      let frameDt = now - this._lastTickTime;
      this._lastTickTime = now;
      if (frameDt > MAX_FRAME_DT) {
        frameDt = MAX_FRAME_DT;
      }
      if (frameDt < 0) {
        frameDt = 0;
      }

      this._accumulator += frameDt;
      while (this._accumulator >= FIXED_DT) {
        stepWorld(this.world, FIXED_DT);
        this._accumulator -= FIXED_DT;
      }

      this._syncModelTransform();
    },

    _syncModelTransform() {
      const p = this.dynamicBody.position;
      const q = this.dynamicBody.quaternion;
      const node = this.modelNode;
      if (!node || typeof node.setAttribute !== 'function') {
        return;
      }

      // Defensive guard: a NaN position (e.g. from a physics edge case)
      // would render as "NaN NaN NaN" and make the node invisible with no
      // thrown error, so skip the write and warn once rather than silently
      // corrupting the transform every frame.
      const hasNaN = Number.isNaN(p.x) || Number.isNaN(p.y) || Number.isNaN(p.z);
      if (hasNaN) {
        if (!this._warnedNaN) {
          this._warnedNaN = true;
          console.error('[xr-viewer] dynamicBody.position is NaN!', p);
        }
        return;
      }

      node.setAttribute('position', `${p.x} ${p.y} ${p.z}`);

      // Rotation representation (quaternion vs Euler) is unconfirmed --
      // xr-light's `rotation="x y z"` WXML attribute suggests Euler degrees,
      // so that's the primary attempt via the same setAttribute path as
      // position above. Wrapped so a wrong guess here never breaks position.
      try {
        const euler = quaternionToEulerDegrees(q);
        node.setAttribute('rotation', `${euler.x} ${euler.y} ${euler.z}`);
      } catch (err) {
        if (!this._warnedNoRotation) {
          this._warnedNoRotation = true;
          console.warn('[xr-viewer] rotation sync failed (position still applied):', err);
        }
      }
    },

    // Bound to bind:touch-shape on the model's cube-shape. `e` carries an
    // IShapeTouchEvent per docs; Phase 1 doesn't need the hit point, just
    // "a tap landed on the model" as the trigger for the jump impulse.
    onTouchModel(e) {
      if (!this.dynamicBody) {
        return;
      }
      const body = this.dynamicBody;
      const randX = (Math.random() - 0.5) * 2 * TAP_HORIZONTAL_SPREAD;
      const randZ = (Math.random() - 0.5) * 2 * TAP_HORIZONTAL_SPREAD;

      body.velocity.x += randX;
      body.velocity.y += TAP_UPWARD_VELOCITY;
      body.velocity.z += randZ;
      body.wakeUp();
    },

    // Called by the page (viewer.js) via selectComponent('#viewer').reset().
    // Restores both halves -- the cannon-es body AND the visible xr-frame
    // node transform -- synchronously in the same call, so there's no
    // one-frame visual lag waiting for the next onTick to copy state across.
    reset() {
      if (!this.dynamicBody || !this._initialBodyState) {
        return;
      }
      const s = this._initialBodyState;
      const body = this.dynamicBody;

      body.position.set(s.position.x, s.position.y, s.position.z);
      body.quaternion.set(
        s.quaternion.x,
        s.quaternion.y,
        s.quaternion.z,
        s.quaternion.w
      );
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.wakeUp();

      this._syncModelTransform();
    },
  },
});
