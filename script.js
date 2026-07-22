/* =========================================================================
   FLOATING WALL — HAND FIELD
   Vanilla JS + Three.js + MediaPipe Hands
   ========================================================================= */

(() => {
  'use strict';

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
    FIELD_RADIUS: 3.4,        // world-space radius of hand influence
    FIELD_STRENGTH: 3.4,      // max push distance
    FINGER_RADIUS: 1.6,       // smaller, sharper influence for fingertips
    FINGER_STRENGTH: 2.2,
    SPRING_STIFFNESS: 0.055,
    SPRING_DAMPING: 0.82,
    ROT_SPRING_STIFFNESS: 0.06,
    ROT_SPRING_DAMPING: 0.80,
    CAPTURE_SIZE: 512,        // capture canvas resolution (square, cropped)
    BLOOM_STRENGTH: 0.55,
    BLOOM_RADIUS: 0.4,
    BLOOM_THRESHOLD: 0.55,
    SMOOTHING: 0.45,          // hand landmark smoothing factor
  };

  // ---------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------
  const videoEl = document.getElementById('webcam');
  const captureCanvas = document.getElementById('captureCanvas');
  const glCanvas = document.getElementById('glCanvas');
  const loaderEl = document.getElementById('loader');
  const permErrorEl = document.getElementById('permissionError');
  const handStatusDot = document.getElementById('handStatus');
  const handStatusText = document.getElementById('handStatusText');

  const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: false });

  // ---------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------
  const state = {
    videoReady: false,
    handTracking: null,       // { palm: {x,y,z}, fingers: [{x,y,z}...], active: bool }
    handTrackingRaw: null,
    handActive: false,
    lastHandSeenAt: 0,
    time: 0,
  };

  // ---------------------------------------------------------------------
  // THREE.JS SETUP
  // ---------------------------------------------------------------------
  let renderer, scene, camera, composer, bloomPass;
  let tileGroup;
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
    renderer.setClearColor(0x000000, 0); // transparent so webcam shows through gaps
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(
      42,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    );
    camera.position.set(0, 0, 14);
    camera.lookAt(0, 0, 0);

    // Ambient lighting — soft, cinematic
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

    // invisible shadow-catcher plane behind the wall (subtle, for depth)
    const shadowPlaneGeo = new THREE.PlaneGeometry(40, 30);
    const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.18 });
    const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
    shadowPlane.position.z = -CONFIG.DEPTH_RANGE - 1.5;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    tileGroup = new THREE.Group();
    scene.add(tileGroup);

    // Postprocessing — bloom for glass/soft glow
    composer = new THREE.EffectComposer(renderer);
    const renderPass = new THREE.RenderPass(scene, camera);
    composer.addPass(renderPass);

    bloomPass = new THREE.UnrealBloomPass(
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

  // ---------------------------------------------------------------------
  // TILE TEXTURE (shared video texture, tiles use UV offsets)
  // ---------------------------------------------------------------------
  let videoTexture;

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

      // Grid-based home position with jitter for organic layout
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

      // random tile size — mix of tall slivers and wide cards, like reference image
      const sizeRoll = Math.random();
      let w, h;
      if (sizeRoll < 0.28) {
        // thin sliver
        w = 0.18 + Math.random() * 0.22;
        h = 0.9 + Math.random() * 1.6;
      } else if (sizeRoll < 0.55) {
        // wide flat card
        w = 0.9 + Math.random() * 1.3;
        h = 0.35 + Math.random() * 0.35;
      } else {
        // normal card
        w = 0.55 + Math.random() * 0.85;
        h = 0.55 + Math.random() * 0.85;
      }
      this.width = w;
      this.height = h;

      // random UV crop region of the video feed
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

      // remap UVs to sample a cropped region of the shared video texture
      const uvAttr = geo.attributes.uv;
      for (let i = 0; i < uvAttr.count; i++) {
        const u = uvAttr.getX(i);
        const v = uvAttr.getY(i);
        uvAttr.setXY(
          i,
          this.uvOffsetX + u * this.uvScale,
          this.uvOffsetY + v * this.uvScale
        );
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

      // thin edge frame for a "glass card" look
      const edgeGeo = new THREE.EdgesGeometry(geo);
      const edgeMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.08,
      });
      const edges = new THREE.LineSegments(edgeGeo, edgeMat);
      mesh.add(edges);

      return mesh;
    }

    // apply force from a point (palm or fingertip) in world space
    applyPointForce(point, radius, strength, out) {
      const dx = this.pos.x - point.x;
      const dy = this.pos.y - point.y;
      const dz = this.pos.z - point.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const r = radius;
      if (distSq > r * r) return;

      const dist = Math.sqrt(distSq) || 0.0001;
      const falloff = 1.0 - dist / r;
      const eased = falloff * falloff * (3 - 2 * falloff); // smoothstep
      const pushMag = eased * strength;

      out.x += (dx / dist) * pushMag;
      out.y += (dy / dist) * pushMag;
      out.z += (dz / dist) * pushMag * 0.6 + eased * strength * 0.5; // push toward viewer too
    }

    update(dt, handPoints, explodeForce) {
      // Gentle ambient float (always active, like a living gallery)
      this.floatPhase += dt * this.floatSpeed;
      const floatOffset = Math.sin(this.floatPhase) * this.floatAmp;

      // target = home + float
      const targetX = this.home.x;
      const targetY = this.home.y + floatOffset;
      const targetZ = this.home.z;

      // accumulate force-field displacement from hand points
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

      // explode force (radial from center, decays over time via passed multiplier)
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

      // spring physics toward desired position — not linear, feels physical
      const ax = (desiredX - this.pos.x) * CONFIG.SPRING_STIFFNESS;
      const ay = (desiredY - this.pos.y) * CONFIG.SPRING_STIFFNESS;
      const az = (desiredZ - this.pos.z) * CONFIG.SPRING_STIFFNESS;

      this.vel.x = (this.vel.x + ax) * CONFIG.SPRING_DAMPING;
      this.vel.y = (this.vel.y + ay) * CONFIG.SPRING_DAMPING;
      this.vel.z = (this.vel.z + az) * CONFIG.SPRING_DAMPING;

      this.pos.x += this.vel.x;
      this.pos.y += this.vel.y;
      this.pos.z += this.vel.z;

      // rotation reacts to displacement magnitude & direction — natural tumble
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

      // commit to mesh (GPU transform only, no layout thrash)
      this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
      this.mesh.rotation.set(this.rot.x, this.rot.y, this.rot.z);

      // subtle opacity/emissive shift based on proximity for a "reactive glass" feel
      const proximity = Math.min(dispMag / 2.5, 1);
      this.mesh.material.clearcoat = 0.6 + proximity * 0.3;
    }
  }

  // ---------------------------------------------------------------------
  // BUILD WALL
  // ---------------------------------------------------------------------
  function buildWall() {
    let index = 0;
    const total = CONFIG.TILE_COUNT;
    const cols = CONFIG.GRID_COLS;
    const rows = CONFIG.GRID_ROWS;
    const cells = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        cells.push([x, y]);
      }
    }
    // shuffle cells, take as many as needed (allows TILE_COUNT < cols*rows)
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }

    const count = Math.min(total, cells.length);
    for (let i = 0; i < count; i++) {
      const [gx, gy] = cells[i];
      const tile = new Tile(index++, gx, gy);
      tiles.push(tile);
      tileGroup.add(tile.mesh);
    }
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
  let explodeAmount = 0;      // current explode force magnitude, decays to 0
  let exploding = false;

  function triggerExplode() {
    exploding = true;
    explodeAmount = 6.5;
  }

  // ---------------------------------------------------------------------
  // COORDINATE MAPPING: normalized hand coords -> world space
  // ---------------------------------------------------------------------
  function normToWorld(nx, ny, nz) {
    // MediaPipe: x,y in [0,1] (origin top-left of the (mirrored) input image), z relative depth
    // Camera is mirrored via CSS (scaleX(-1)); MediaPipe runs on the raw (unmirrored) frame,
    // so we flip x here to match what the user visually sees.
    const worldX = (1 - nx - 0.5) * CONFIG.WALL_WIDTH * 1.15;
    const worldY = (0.5 - ny) * CONFIG.WALL_HEIGHT * 1.15;
    const worldZ = (nz || 0) * -8; // MediaPipe z: negative = closer to camera
    return new THREE.Vector3(worldX, worldY, worldZ);
  }

  // ---------------------------------------------------------------------
  // MEDIAPIPE HANDS
  // ---------------------------------------------------------------------
  let hands, mpCamera;
  const smoothedPalm = new THREE.Vector3();
  const smoothedFingers = [];
  let smoothInit = false;

  function onHandsResults(results) {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      state.handActive = false;
      updateHandStatus(false);
      return;
    }

    const landmarks = results.multiHandLandmarks[0];

    // Palm center: average of wrist(0) + base of index(5) + base of pinky(17)
    const wrist = landmarks[0];
    const indexBase = landmarks[5];
    const pinkyBase = landmarks[17];
    const palmNX = (wrist.x + indexBase.x + pinkyBase.x) / 3;
    const palmNY = (wrist.y + indexBase.y + pinkyBase.y) / 3;
    const palmNZ = (wrist.z + indexBase.z + pinkyBase.z) / 3;

    const palmWorld = normToWorld(palmNX, palmNY, palmNZ);

    // Fingertips: thumb(4), index(8), middle(12), ring(16), pinky(20)
    const tipIndices = [4, 8, 12, 16, 20];
    const fingerWorlds = tipIndices.map((idx) => {
      const lm = landmarks[idx];
      return normToWorld(lm.x, lm.y, lm.z);
    });

    if (!smoothInit) {
      smoothedPalm.copy(palmWorld);
      fingerWorlds.forEach((f, i) => {
        smoothedFingers[i] = f.clone();
      });
      smoothInit = true;
    } else {
      smoothedPalm.lerp(palmWorld, CONFIG.SMOOTHING);
      fingerWorlds.forEach((f, i) => {
        if (!smoothedFingers[i]) smoothedFingers[i] = f.clone();
        else smoothedFingers[i].lerp(f, CONFIG.SMOOTHING);
      });
    }

    state.handTracking = {
      palm: smoothedPalm,
      fingers: smoothedFingers,
    };
    state.handActive = true;
    state.lastHandSeenAt = performance.now();
    updateHandStatus(true);
  }

  function updateHandStatus(active) {
    if (active === state._lastStatusFlag) return;
    state._lastStatusFlag = active;
    if (active) {
      handStatusDot.classList.remove('dot-off');
      handStatusDot.classList.add('dot-on');
      handStatusText.textContent = 'hand tracked';
    } else {
      handStatusDot.classList.remove('dot-on');
      handStatusDot.classList.add('dot-off');
      handStatusText.textContent = 'no hand';
    }
  }

  async function initHandTracking() {
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
        await hands.send({ image: videoEl });
      },
      width: 640,
      height: 480,
    });
    mpCamera.start();
  }

  // treat hand as inactive if not seen for a short window (avoids flicker on missed frames)
  function updateHandTimeout() {
    if (state.handActive && performance.now() - state.lastHandSeenAt > 350) {
      state.handActive = false;
      updateHandStatus(false);
    }
  }

  // ---------------------------------------------------------------------
  // WEBCAM INIT
  // ---------------------------------------------------------------------
  async function initWebcam() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      videoEl.srcObject = stream;
      await new Promise((resolve) => {
        videoEl.onloadedmetadata = () => {
          videoEl.play();
          resolve();
        };
      });
      state.videoReady = true;
    } catch (err) {
      console.error('Camera access failed:', err);
      permErrorEl.classList.remove('hidden');
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // ANIMATION LOOP
  // ---------------------------------------------------------------------
  let lastFrameTime = performance.now();

  function animate(now) {
    requestAnimationFrame(animate);

    const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
    lastFrameTime = now;
    state.time += dt;

    updateHandTimeout();

    // decay explode force smoothly back to 0 (spring-like regroup)
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

    // gentle whole-group parallax drift for cinematic feel
    tileGroup.rotation.y = Math.sin(state.time * 0.05) * 0.02;
    tileGroup.rotation.x = Math.cos(state.time * 0.04) * 0.012;

    if (videoTexture) videoTexture.needsUpdate = true;

    composer.render();
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
  // BOOT
  // ---------------------------------------------------------------------
  async function boot() {
    try {
      await initWebcam();
    } catch (e) {
      return; // permission error already shown
    }

    initThree();
    initVideoTexture();
    buildWall();
    initControls();
    await initHandTracking();

    loaderEl.classList.add('hidden');
    requestAnimationFrame(animate);
  }

  boot();
})();
