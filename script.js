/* =========================================================================
   FLOATING WALL — HAND FIELD
   Vanilla JS + Three.js (ES modules) + MediaPipe Hands
   ========================================================================= */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const DEV_MODE = true; // shows on-screen error panel; set false for production

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------
const CONFIG = {
  TILE_COUNT: 190,
  GRID_COLS: 16,
  GRID_ROWS: 12,
  WALL_WIDTH: 20,
  WALL_HEIGHT: 13,
  DEPTH_RANGE: 3.2,
  FIELD_RADIUS: 3.4,
  FIELD_STRENGTH: 3.4,
  FINGER_RADIUS: 1.6,
  FINGER_STRENGTH: 2.2,
  SPRING_STIFFNESS: 0.055,
  SPRING_DAMPING: 0.82,
  ROT_SPRING_STIFFNESS: 0.06,
  ROT_SPRING_DAMPING: 0.80,
  BLOOM_STRENGTH: 0.55,
  BLOOM_RADIUS: 0.4,
  BLOOM_THRESHOLD: 0.55,
  SMOOTHING: 0.45,
  TILES_PER_BATCH: 20,       // progressive creation batch size
  BATCH_INTERVAL_MS: 40,     // spacing between batches so frame rate stays smooth
  HAND_TRACKING_TIMEOUT_MS: 10000,
};

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------
const videoEl = document.getElementById('webcam');
const loaderEl = document.getElementById('loader');
const loaderTextEl = document.getElementById('loaderText');
const permErrorEl = document.getElementById('permissionError');
const permErrorBodyEl = document.getElementById('permErrorBody');
const handStatusDot = document.getElementById('handStatus');
const handStatusText = document.getElementById('handStatusText');
const warningBannerEl = document.getElementById('warningBanner');
const errorPanelEl = document.getElementById('errorPanel');
const glCanvas = document.getElementById('glCanvas');

// ---------------------------------------------------------------------
// ERROR / WARNING UI HELPERS
// ---------------------------------------------------------------------
function logError(context, err) {
  console.error(`[FloatingWall] ${context}:`, err);
  if (!DEV_MODE) return;
  errorPanelEl.classList.remove('hidden');
  const title = errorPanelEl.querySelector('.err-title');
  if (!title) {
    errorPanelEl.innerHTML = '<span class="err-title">Dev Error Log</span>';
  }
  const line = document.createElement('div');
  const msg = err && err.message ? err.message : String(err);
  line.textContent = `• ${context}: ${msg}`;
  errorPanelEl.appendChild(line);
}

let warningTimeout = null;
function showWarning(text, autoHideMs) {
  warningBannerEl.textContent = text;
  warningBannerEl.classList.remove('hidden');
  if (warningTimeout) clearTimeout(warningTimeout);
  if (autoHideMs) {
    warningTimeout = setTimeout(() => {
      warningBannerEl.classList.add('hidden');
    }, autoHideMs);
  }
}
function hideWarning() {
  warningBannerEl.classList.add('hidden');
}

function hideLoader() {
  loaderEl.classList.add('hidden');
}

function setLoaderText(text) {
  if (loaderTextEl) loaderTextEl.textContent = text;
}

function setHandStatus(mode) {
  // mode: 'off' | 'pending' | 'on'
  handStatusDot.classList.remove('dot-off', 'dot-pending', 'dot-on');
  handStatusDot.classList.add(`dot-${mode}`);
  handStatusText.textContent =
    mode === 'on' ? 'hand tracked' : mode === 'pending' ? 'tracking loading…' : 'no hand';
}

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
const state = {
  handTracking: null,
  handActive: false,
  lastHandSeenAt: 0,
  time: 0,
  handTrackingReady: false,
  handTrackingFailed: false,
  _lastStatusFlag: null,
};

// ---------------------------------------------------------------------
// THREE.JS SETUP
// ---------------------------------------------------------------------
let renderer, scene, camera, composer;
let tileGroup;
let videoTexture;
const tiles = [];

function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas: glCanvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 14);
  camera.lookAt(0, 0, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(5, 8, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -12;
  key.shadow.camera.right = 12;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -12;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 30;
  key.shadow.bias = -0.001;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x8fb8ff, 0.35);
  rim.position.set(-8, -4, -6);
  scene.add(rim);

  const fill = new THREE.PointLight(0xffffff, 0.4, 30);
  fill.position.set(0, 0, 8);
  scene.add(fill);

  const shadowPlaneGeo = new THREE.PlaneGeometry(40, 30);
  const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.18 });
  const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
  shadowPlane.position.z = -CONFIG.DEPTH_RANGE - 1.5;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  tileGroup = new THREE.Group();
  scene.add(tileGroup);

  // Postprocessing — correct ES module composer/pass classes for this Three.js version
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    CONFIG.BLOOM_STRENGTH,
    CONFIG.BLOOM_RADIUS,
    CONFIG.BLOOM_THRESHOLD
  );
  composer.addPass(bloomPass);

  window.addEventListener('resize', onResize);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
}

function initVideoTexture() {
  videoTexture = new THREE.VideoTexture(videoEl);
  videoTexture.colorSpace = THREE.SRGBColorSpace;
  videoTexture.minFilter = THREE.LinearFilter;
  videoTexture.magFilter = THREE.LinearFilter;
  videoTexture.generateMipmaps = false;
  videoTexture.wrapS = THREE.ClampToEdgeWrapping;
  videoTexture.wrapT = THREE.ClampToEdgeWrapping;
}

// ---------------------------------------------------------------------
// TILE CLASS
// ---------------------------------------------------------------------
class Tile {
  constructor(index, gridX, gridY) {
    this.index = index;

    const cellW = CONFIG.WALL_WIDTH / CONFIG.GRID_COLS;
    const cellH = CONFIG.WALL_HEIGHT / CONFIG.GRID_ROWS;

    const jitterX = (Math.random() - 0.5) * cellW * 0.5;
    const jitterY = (Math.random() - 0.5) * cellH * 0.5;

    const homeX = (gridX - CONFIG.GRID_COLS / 2 + 0.5) * cellW + jitterX;
    const homeY = (gridY - CONFIG.GRID_ROWS / 2 + 0.5) * cellH + jitterY;
    const homeZ = (Math.random() - 0.5) * CONFIG.DEPTH_RANGE;

    this.home = new THREE.Vector3(homeX, homeY, homeZ);
    this.pos = this.home.clone();
    this.vel = new THREE.Vector3();

    this.homeRot = new THREE.Euler(
      (Math.random() - 0.5) * 0.5,
      (Math.random() - 0.5) * 0.6,
      (Math.random() - 0.5) * 0.35
    );
    this.rot = new THREE.Euler().copy(this.homeRot);
    this.rotVel = new THREE.Vector3();

    const sizeRoll = Math.random();
    let w, h;
    if (sizeRoll < 0.28) {
      w = 0.18 + Math.random() * 0.22;
      h = 0.9 + Math.random() * 1.6;
    } else if (sizeRoll < 0.55) {
      w = 0.9 + Math.random() * 1.3;
      h = 0.35 + Math.random() * 0.35;
    } else {
      w = 0.55 + Math.random() * 0.85;
      h = 0.55 + Math.random() * 0.85;
    }
    this.width = w;
    this.height = h;

    this.uvOffsetX = Math.random() * 0.75;
    this.uvOffsetY = Math.random() * 0.75;
    this.uvScale = 0.15 + Math.random() * 0.2;

    this.floatPhase = Math.random() * Math.PI * 2;
    this.floatSpeed = 0.3 + Math.random() * 0.4;
    this.floatAmp = 0.04 + Math.random() * 0.06;

    this.mesh = this.buildMesh();
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.copy(this.rot);
  }

  buildMesh() {
    const geo = new THREE.PlaneGeometry(this.width, this.height, 1, 1);

    const uvAttr = geo.attributes.uv;
    for (let i = 0; i < uvAttr.count; i++) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      uvAttr.setXY(i, this.uvOffsetX + u * this.uvScale, this.uvOffsetY + v * this.uvScale);
    }
    uvAttr.needsUpdate = true;

    const mat = new THREE.MeshPhysicalMaterial({
      map: videoTexture,
      roughness: 0.28,
      metalness: 0.08,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
      reflectivity: 0.5,
      envMapIntensity: 0.8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.98,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const edgeGeo = new THREE.EdgesGeometry(geo);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08 });
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    mesh.add(edges);

    return mesh;
  }

  applyPointForce(point, radius, strength, out) {
    const dx = this.pos.x - point.x;
    const dy = this.pos.y - point.y;
    const dz = this.pos.z - point.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    const r = radius;
    if (distSq > r * r) return;

    const dist = Math.sqrt(distSq) || 0.0001;
    const falloff = 1.0 - dist / r;
    const eased = falloff * falloff * (3 - 2 * falloff);
    const pushMag = eased * strength;

    out.x += (dx / dist) * pushMag;
    out.y += (dy / dist) * pushMag;
    out.z += (dz / dist) * pushMag * 0.6 + eased * strength * 0.5;
  }

  update(dt, handPoints, explodeForce) {
    this.floatPhase += dt * this.floatSpeed;
    const floatOffset = Math.sin(this.floatPhase) * this.floatAmp;

    const targetX = this.home.x;
    const targetY = this.home.y + floatOffset;
    const targetZ = this.home.z;

    const force = { x: 0, y: 0, z: 0 };

    if (handPoints) {
      if (handPoints.palm) {
        this.applyPointForce(handPoints.palm, CONFIG.FIELD_RADIUS, CONFIG.FIELD_STRENGTH, force);
      }
      if (handPoints.fingers) {
        for (let i = 0; i < handPoints.fingers.length; i++) {
          this.applyPointForce(handPoints.fingers[i], CONFIG.FINGER_RADIUS, CONFIG.FINGER_STRENGTH, force);
        }
      }
    }

    if (explodeForce > 0.0001) {
      const dirX = this.home.x || (Math.random() - 0.5);
      const dirY = this.home.y || (Math.random() - 0.5);
      const dirZ = this.home.z || (Math.random() - 0.5);
      const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
      force.x += (dirX / len) * explodeForce;
      force.y += (dirY / len) * explodeForce;
      force.z += (dirZ / len) * explodeForce * 0.7;
    }

    const desiredX = targetX + force.x;
    const desiredY = targetY + force.y;
    const desiredZ = targetZ + force.z;

    const ax = (desiredX - this.pos.x) * CONFIG.SPRING_STIFFNESS;
    const ay = (desiredY - this.pos.y) * CONFIG.SPRING_STIFFNESS;
    const az = (desiredZ - this.pos.z) * CONFIG.SPRING_STIFFNESS;

    this.vel.x = (this.vel.x + ax) * CONFIG.SPRING_DAMPING;
    this.vel.y = (this.vel.y + ay) * CONFIG.SPRING_DAMPING;
    this.vel.z = (this.vel.z + az) * CONFIG.SPRING_DAMPING;

    this.pos.x += this.vel.x;
    this.pos.y += this.vel.y;
    this.pos.z += this.vel.z;

    const dispX = this.pos.x - this.home.x;
    const dispY = this.pos.y - this.home.y;
    const dispZ = this.pos.z - this.home.z;
    const dispMag = Math.sqrt(dispX * dispX + dispY * dispY + dispZ * dispZ);

    const targetRotX = this.homeRot.x + dispY * 0.35 + dispZ * 0.12;
    const targetRotY = this.homeRot.y + dispX * -0.35 + dispZ * 0.1;
    const targetRotZ = this.homeRot.z + dispX * 0.15 - dispY * 0.15;

    const rax = (targetRotX - this.rot.x) * CONFIG.ROT_SPRING_STIFFNESS;
    const ray = (targetRotY - this.rot.y) * CONFIG.ROT_SPRING_STIFFNESS;
    const raz = (targetRotZ - this.rot.z) * CONFIG.ROT_SPRING_STIFFNESS;

    this.rotVel.x = (this.rotVel.x + rax) * CONFIG.ROT_SPRING_DAMPING;
    this.rotVel.y = (this.rotVel.y + ray) * CONFIG.ROT_SPRING_DAMPING;
    this.rotVel.z = (this.rotVel.z + raz) * CONFIG.ROT_SPRING_DAMPING;

    this.rot.x += this.rotVel.x;
    this.rot.y += this.rotVel.y;
    this.rot.z += this.rotVel.z;

    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.mesh.rotation.set(this.rot.x, this.rot.y, this.rot.z);

    const proximity = Math.min(dispMag / 2.5, 1);
    this.mesh.material.clearcoat = 0.6 + proximity * 0.3;
  }
}

// ---------------------------------------------------------------------
// PROGRESSIVE WALL BUILD — avoids a large synchronous stall on startup
// ---------------------------------------------------------------------
let wallCells = [];
let wallBuildIndex = 0;
let wallBuildTimer = null;

function prepareWallCells() {
  const cols = CONFIG.GRID_COLS;
  const rows = CONFIG.GRID_ROWS;
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) cells.push([x, y]);
  }
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  wallCells = cells.slice(0, Math.min(CONFIG.TILE_COUNT, cells.length));
  wallBuildIndex = 0;
}

function buildWallProgressively(onComplete) {
  prepareWallCells();

  function addBatch() {
    try {
      const end = Math.min(wallBuildIndex + CONFIG.TILES_PER_BATCH, wallCells.length);
      for (; wallBuildIndex < end; wallBuildIndex++) {
        const [gx, gy] = wallCells[wallBuildIndex];
        const tile = new Tile(wallBuildIndex, gx, gy);
        tiles.push(tile);
        tileGroup.add(tile.mesh);
      }
    } catch (err) {
      logError('Tile batch creation', err);
    }

    if (wallBuildIndex < wallCells.length) {
      wallBuildTimer = setTimeout(addBatch, CONFIG.BATCH_INTERVAL_MS);
    } else {
      if (onComplete) onComplete();
    }
  }

  addBatch();
}

function randomizeLayout() {
  tiles.forEach((tile) => {
    const cellW = CONFIG.WALL_WIDTH / CONFIG.GRID_COLS;
    const cellH = CONFIG.WALL_HEIGHT / CONFIG.GRID_ROWS;
    const gx = Math.random() * CONFIG.GRID_COLS;
    const gy = Math.random() * CONFIG.GRID_ROWS;
    tile.home.x = (gx - CONFIG.GRID_COLS / 2) * cellW;
    tile.home.y = (gy - CONFIG.GRID_ROWS / 2) * cellH;
    tile.home.z = (Math.random() - 0.5) * CONFIG.DEPTH_RANGE;
    tile.homeRot.set(
      (Math.random() - 0.5) * 0.6,
      (Math.random() - 0.5) * 0.7,
      (Math.random() - 0.5) * 0.4
    );
  });
}

// ---------------------------------------------------------------------
// EXPLODE / REGROUP
// ---------------------------------------------------------------------
let explodeAmount = 0;
let exploding = false;

function triggerExplode() {
  exploding = true;
  explodeAmount = 6.5;
}

// ---------------------------------------------------------------------
// COORDINATE MAPPING
// ---------------------------------------------------------------------
function normToWorld(nx, ny, nz) {
  const worldX = (1 - nx - 0.5) * CONFIG.WALL_WIDTH * 1.15;
  const worldY = (0.5 - ny) * CONFIG.WALL_HEIGHT * 1.15;
  const worldZ = (nz || 0) * -8;
  return new THREE.Vector3(worldX, worldY, worldZ);
}

// ---------------------------------------------------------------------
// MEDIAPIPE HANDS — fully decoupled from render start
// ---------------------------------------------------------------------
let hands, mpCamera;
const smoothedPalm = new THREE.Vector3();
const smoothedFingers = [];
let smoothInit = false;

function onHandsResults(results) {
  try {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      state.handActive = false;
      updateHandStatus(false);
      return;
    }

    const landmarks = results.multiHandLandmarks[0];

    const wrist = landmarks[0];
    const indexBase = landmarks[5];
    const pinkyBase = landmarks[17];
    const palmNX = (wrist.x + indexBase.x + pinkyBase.x) / 3;
    const palmNY = (wrist.y + indexBase.y + pinkyBase.y) / 3;
    const palmNZ = (wrist.z + indexBase.z + pinkyBase.z) / 3;

    const palmWorld = normToWorld(palmNX, palmNY, palmNZ);

    const tipIndices = [4, 8, 12, 16, 20];
    const fingerWorlds = tipIndices.map((idx) => {
      const lm = landmarks[idx];
      return normToWorld(lm.x, lm.y, lm.z);
    });

    if (!smoothInit) {
      smoothedPalm.copy(palmWorld);
      fingerWorlds.forEach((f, i) => { smoothedFingers[i] = f.clone(); });
      smoothInit = true;
    } else {
      smoothedPalm.lerp(palmWorld, CONFIG.SMOOTHING);
      fingerWorlds.forEach((f, i) => {
        if (!smoothedFingers[i]) smoothedFingers[i] = f.clone();
        else smoothedFingers[i].lerp(f, CONFIG.SMOOTHING);
      });
    }

    state.handTracking = { palm: smoothedPalm, fingers: smoothedFingers };
    state.handActive = true;
    state.lastHandSeenAt = performance.now();
    updateHandStatus(true);
  } catch (err) {
    logError('onHandsResults', err);
  }
}

function updateHandStatus(active) {
  if (active === state._lastStatusFlag) return;
  state._lastStatusFlag = active;
  setHandStatus(active ? 'on' : 'off');
}

function updateHandTimeout() {
  if (state.handActive && performance.now() - state.lastHandSeenAt > 350) {
    state.handActive = false;
    updateHandStatus(false);
  }
}

// Initializes hand tracking asynchronously; never blocks render start.
// Retries in the background if it fails or exceeds the timeout.
function initHandTrackingAsync() {
  setHandStatus('pending');

  let settled = false;
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    state.handTrackingFailed = true;
    showWarning('Hand tracking is taking longer than expected — running webcam + scene only. Retrying in background…');
    setHandStatus('off');
    // keep retrying quietly in the background
    retryHandTrackingLoop();
  }, CONFIG.HAND_TRACKING_TIMEOUT_MS);

  (async () => {
    try {
      if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
        throw new Error('MediaPipe Hands/Camera globals not available');
      }

      hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.65,
        minTrackingConfidence: 0.6,
      });
      hands.onResults(onHandsResults);

      mpCamera = new Camera(videoEl, {
        onFrame: async () => {
          try {
            await hands.send({ image: videoEl });
          } catch (err) {
            // per-frame errors shouldn't crash tracking; log once in a while
            logError('hands.send frame', err);
          }
        },
        width: 640,
        height: 480,
      });
      await mpCamera.start();

      if (settled) return; // timeout already fired; still fine, tracking is now live
      settled = true;
      clearTimeout(timeoutId);
      state.handTrackingReady = true;
      state.handTrackingFailed = false;
      hideWarning();
      setHandStatus('off'); // off until a hand is actually seen
    } catch (err) {
      logError('initHandTrackingAsync', err);
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        state.handTrackingFailed = true;
        showWarning('Hand tracking failed to start — running webcam + scene only. Retrying in background…');
        setHandStatus('off');
        retryHandTrackingLoop();
      }
    }
  })();
}

let retryScheduled = false;
function retryHandTrackingLoop() {
  if (retryScheduled) return;
  retryScheduled = true;
  setTimeout(() => {
    retryScheduled = false;
    if (state.handTrackingReady) return; // succeeded via another path
    initHandTrackingAsync();
  }, 8000);
}

// ---------------------------------------------------------------------
// WEBCAM INIT — first and only blocking step for the loader
// ---------------------------------------------------------------------
async function initWebcam() {
  setLoaderText('requesting camera access');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  videoEl.srcObject = stream;

  setLoaderText('starting video feed');
  await new Promise((resolve, reject) => {
    const onReady = () => {
      videoEl.play().then(resolve).catch(reject);
    };
    if (videoEl.readyState >= 1) {
      onReady();
    } else {
      videoEl.onloadedmetadata = onReady;
    }
  });

  // Wait for the first real frame so the loader never hides on a black video element
  await new Promise((resolve) => {
    if (videoEl.readyState >= 2) return resolve();
    videoEl.addEventListener('loadeddata', () => resolve(), { once: true });
  });
}

// ---------------------------------------------------------------------
// ANIMATION LOOP — starts as soon as Three.js + first tile batch exist
// ---------------------------------------------------------------------
let lastFrameTime = performance.now();
let animationStarted = false;

function animate(now) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  state.time += dt;

  updateHandTimeout();

  if (exploding) {
    explodeAmount *= 0.92;
    if (explodeAmount < 0.01) {
      explodeAmount = 0;
      exploding = false;
    }
  }

  const handPoints = state.handActive ? state.handTracking : null;

  for (let i = 0; i < tiles.length; i++) {
    tiles[i].update(dt, handPoints, explodeAmount);
  }

  tileGroup.rotation.y = Math.sin(state.time * 0.05) * 0.02;
  tileGroup.rotation.x = Math.cos(state.time * 0.04) * 0.012;

  if (videoTexture) videoTexture.needsUpdate = true;

  try {
    composer.render();
  } catch (err) {
    logError('composer.render', err);
  }
}

function startAnimationLoopOnce() {
  if (animationStarted) return;
  animationStarted = true;
  requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------
// INPUT
// ---------------------------------------------------------------------
function initControls() {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR') {
      randomizeLayout();
    } else if (e.code === 'Space') {
      e.preventDefault();
      triggerExplode();
    }
  });
}

// ---------------------------------------------------------------------
// BOOT — strict step order per spec, each step isolated by try/catch,
// rendering never blocked on hand tracking.
// ---------------------------------------------------------------------
async function boot() {
  // Step 1 + 2: webcam permission -> visible feed
  try {
    await initWebcam();
  } catch (err) {
    logError('initWebcam', err);
    const msg = err && err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Please allow camera access and reload.'
      : 'Could not access the camera. Please check your device and reload.';
    permErrorBodyEl.textContent = msg;
    permErrorEl.classList.remove('hidden');
    hideLoader();
    return; // nothing else can proceed without the camera
  }

  // Webcam is visible now — loader can come down immediately.
  hideLoader();

  // Step 3: initialize Three.js
  try {
    initThree();
    initVideoTexture();
  } catch (err) {
    logError('initThree', err);
    showWarning('3D renderer failed to initialize. Reload to try again.');
    return;
  }

  // Step 4 + 5: kick off hand tracking asynchronously, and start rendering
  // immediately without waiting for it — build tiles progressively so we
  // never stall the main thread with hundreds of synchronous allocations.
  try {
    initControls();
  } catch (err) {
    logError('initControls', err);
  }

  buildWallProgressively(() => {
    // wall complete — nothing else required, animation loop already running
  });

  // Start the render loop as soon as the renderer + at least the group exist.
  startAnimationLoopOnce();

  // Step 6: hand tracking loads in the background; interaction enables
  // automatically once state.handTrackingReady flips true / hand is seen.
  initHandTrackingAsync();
}

boot();
