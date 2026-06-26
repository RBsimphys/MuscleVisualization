/**
 * arm-viewer.js
 *
 * Loads armmodel.glb and exposes setFlexion(pct) where pct is 0-100 (%MVC).
 * Internally rotates the 'Forearm' bone found in the model's skeleton.
 *
 * IMPORTANT - tune these three constants by eye using the on-page debug
 * slider before wiring this to live data. We reset the bone to its rest
 * rotation (0) before exporting, so the model always loads in the
 * extended/neutral pose - this code defines what "100% flexed" means by
 * rotating away from that rest pose. Different bone roll/orientation choices
 * in Blender change which local axis corresponds to "bending the elbow",
 * so the first thing to do once this loads is drag the debug slider and
 * watch which axis/sign actually produces a believable flex, then edit
 * these three values to match.
 */
const FLEX_AXIS = 'x';        // which local axis to rotate around: 'x' | 'y' | 'z'
const FLEX_DIRECTION = 1;     // flip to -1 if the elbow bends the wrong way
const FLEX_MAX_DEGREES = 110; // rotation amount at 100% MVC

// How the whole model is rotated on screen, purely cosmetic (doesn't touch
// the rig). Tune with the "model orientation" debug sliders until the flex
// reads as swinging upward, then copy the values you land on in here.
const MODEL_DISPLAY_ROTATION_DEG = { x: 16, y: -60, z: -110 };

// Padding multiplier applied when auto-framing the camera, so the model
// has room to move into as it flexes (a skinned mesh's CPU-side bounding
// box only reflects the rest pose - three.js doesn't recompute it for
// GPU bone deformation - so we can't measure the flexed extent directly;
// padding generously is the practical fix).
const FRAME_PADDING = 2.2;

class ArmViewer {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.forearmBone = null;
    this.restQuaternion = null;
    this.flexQuaternion = null;
    this._currentPct = 0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f1ea);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.camera.position.set(0.6, 0.6, 0.9);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    container.appendChild(this.renderer.domElement);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.15, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(2, 3, 2);
    this.scene.add(dir);

    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._animate();
  }

  /** @param {string} url path to the .glb, e.g. 'armmodel.glb' */
  loadModel(url) {
    return new Promise((resolve, reject) => {
      const loader = new THREE.GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          this.scene.add(gltf.scene);

          let forearm = null;
          gltf.scene.traverse((node) => {
            if (node.isBone && node.name === 'Forearm') forearm = node;
          });

          if (!forearm) {
            reject(new Error("No bone named 'Forearm' found in the loaded model."));
            return;
          }

          this.forearmBone = forearm;
          this.restQuaternion = forearm.quaternion.clone();

          const axisVec = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[FLEX_AXIS];
          const flexDelta = new THREE.Quaternion().setFromAxisAngle(
            axisVec,
            THREE.MathUtils.degToRad(FLEX_MAX_DEGREES * FLEX_DIRECTION)
          );
          this.flexQuaternion = this.restQuaternion.clone().multiply(flexDelta);

          this.modelRoot = gltf.scene;
          this.setOrientation(MODEL_DISPLAY_ROTATION_DEG);
          this.frameModel();

          resolve(gltf);
        },
        undefined,
        (err) => reject(err)
      );
    });
  }

  /** Rotate the whole displayed model (cosmetic only, the rig is untouched). */
  setOrientation({ x = 0, y = 0, z = 0 }) {
    if (!this.modelRoot) return;
    this.modelRoot.rotation.set(
      THREE.MathUtils.degToRad(x),
      THREE.MathUtils.degToRad(y),
      THREE.MathUtils.degToRad(z)
    );
  }

  /**
   * Re-fit the camera to the model's rest-pose bounding box with generous
   * padding, so there's room for the flex motion even though we can't
   * measure the deformed (flexed) extent directly. Call this again after
   * changing orientation, or any time the view looks off.
   */
  frameModel() {
    if (!this.modelRoot) return;
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const distance = radius * FRAME_PADDING;

    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.8, 0.6, 1.2).normalize().multiplyScalar(distance));
    this.camera.near = Math.max(0.01, distance / 100);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(center);
    this.controls.update();
  }

  /** pct: 0-100, where 0 = rest/extended, 100 = full flex */
  setFlexion(pct) {
    this._currentPct = Math.max(0, Math.min(100, pct));
    if (!this.forearmBone) return;
    const t = this._currentPct / 100;
    this.forearmBone.quaternion.slerpQuaternions(this.restQuaternion, this.flexQuaternion, t);
  }

  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight || w; // square fallback if not sized yet
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
