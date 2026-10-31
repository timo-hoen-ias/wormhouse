// three.js-Darstellung: 3D-Lagerhalle im Hintergrund, Spielfeld als Ebene bei z=0.
import * as THREE from 'three';
import { WORLD_W as W, WORLD_H as H, WATER_Y, WORKER_R } from '../shared/constants.js';
import { mulberry32 } from '../shared/rng.js';
import { GIRDER_LEN, GIRDER_THICK } from './terrain.js';

// Spielkoordinaten (y nach unten) -> three.js (y nach oben)
export const tx = (x) => x;
export const ty = (y) => H - y;

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...opts });
}

// ---------- Modelle ----------
function makeWorkerMesh(teamColor) {
  const g = new THREE.Group();
  const body = new THREE.Group(); // gespiegelt je nach Blickrichtung
  g.add(body);
  const pose = new THREE.Group(); // Squash, Kippen, Salto (Drehpunkt in Körpermitte)
  body.add(pose);
  const pants = mat('#2b3a55');
  const boots = mat('#3b2a1a');
  // Beine an der Hüfte aufgehängt, damit sie beim Laufen richtig schwingen
  const mkLeg = (x) => {
    const hip = new THREE.Group();
    hip.position.set(x, -2, 0);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(4, 7, 5), pants);
    leg.position.y = -3.5;
    const boot = new THREE.Mesh(new THREE.BoxGeometry(5, 2.5, 6), boots);
    boot.position.set(0.5, -7, 0.5);
    hip.add(leg, boot);
    return hip;
  };
  const legL = mkLeg(-2.4);
  const legR = mkLeg(2.4);
  const torsoMat = mat(teamColor, { emissive: teamColor, emissiveIntensity: 0.15 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(11, 10, 7), torsoMat);
  torso.position.y = 2.5;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(11.2, 1.4, 7.2), mat('#e0e0e0', { emissive: '#ffffff', emissiveIntensity: 0.35 }));
  stripe.position.y = 1.5;
  // Kopf als Gruppe (nicken, zurückwerfen beim Treffer)
  const headG = new THREE.Group();
  headG.position.y = 7.5;
  const skin = mat('#f1c27d');
  const head = new THREE.Mesh(new THREE.SphereGeometry(4.2, 16, 12), skin);
  head.position.y = 3.5;
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(4.8, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    mat('#ffd400', { roughness: 0.35 }),
  );
  helmet.position.y = 4.5;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 0.8, 16), mat('#ffd400', { roughness: 0.35 }));
  brim.position.set(0.6, 4.5, 0);
  const eyes = new THREE.Group();
  eyes.position.set(3.4, 4, 0);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 6), mat('#111'));
  eye.position.z = 1.6;
  const eye2 = eye.clone(); eye2.position.z = -1.6;
  eyes.add(eye, eye2);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 2.2), mat('#5d2a1a'));
  mouth.position.set(3.9, 2, 0);
  headG.add(head, helmet, brim, eyes, mouth);
  // Schwindel-Sternchen nach harter Landung
  const stars = new THREE.Group();
  stars.position.y = 10;
  const starMat = new THREE.MeshBasicMaterial({ color: '#ffeb3b' });
  for (let i = 0; i < 3; i++) {
    const st = new THREE.Mesh(new THREE.OctahedronGeometry(1.4), starMat);
    const a = (i / 3) * Math.PI * 2;
    st.position.set(Math.cos(a) * 6, 0, Math.sin(a) * 6);
    stars.add(st);
  }
  stars.visible = false;
  headG.add(stars);
  // Vorderer Arm mit Werkzeug – dreht sich mit dem Zielwinkel
  const arm = new THREE.Group();
  arm.position.set(1, 4, 4);
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(8, 2.6, 2.6), mat(teamColor));
  sleeve.position.x = 4;
  const hand = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 6), skin);
  hand.position.x = 8.2;
  const holder = new THREE.Group(); // hier hängt der gehaltene Gegenstand
  holder.position.x = 9;
  const tool = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 3), mat('#333'));
  holder.add(tool);
  arm.add(sleeve, hand, holder);
  // Hinterer Arm: schwingt beim Laufen, rudert in der Luft
  const armB = new THREE.Group();
  armB.position.set(-1, 6, -4);
  const sleeveB = new THREE.Mesh(new THREE.BoxGeometry(2.6, 8, 2.6), mat(teamColor));
  sleeveB.position.y = -4;
  const handB = new THREE.Mesh(new THREE.SphereGeometry(1.4, 8, 6), skin);
  handB.position.y = -8;
  armB.add(sleeveB, handB);
  pose.add(legL, legR, torso, stripe, headG, arm, armB);
  body.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData = {
    body, pose, arm, armB, legL, legR, headG, eyes, stars, holder, tool, torsoMat, heldId: null,
    st: { squash: 0, hurt: 0, act: null, actT: 0, dizzy: 0, blink: 2 + Math.random() * 3, phase: Math.random() * 6, lastY: null, vy: 0, flip: 0 },
  };
  return g;
}

// Gegenstand in der Hand, passend zur gewählten Waffe
function makeHeldMesh(id) {
  const g = new THREE.Group();
  const add = (geo, m, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); return o; };
  switch (id) {
    case 'paket': { // Druckluftrohr mit Paket
      const tube = add(new THREE.CylinderGeometry(2.2, 2.6, 12, 12), mat('#607d8b', { metalness: 0.6, roughness: 0.4 }), 3);
      tube.rotation.z = Math.PI / 2;
      add(new THREE.BoxGeometry(4, 4, 4), mat('#b98b54'), 9.5);
      break;
    }
    case 'folie':
      add(new THREE.CylinderGeometry(2.8, 2.8, 7, 12), new THREE.MeshPhysicalMaterial({ color: '#cfe8ff', transparent: true, opacity: 0.8, roughness: 0.1 }), 1);
      break;
    case 'kiste': add(new THREE.BoxGeometry(6, 4.5, 5), mat('#1565c0'), 1.5); break;
    case 'scanner': {
      add(new THREE.BoxGeometry(7, 3, 2.5), mat('#212121'), 2);
      add(new THREE.BoxGeometry(2, 5, 2), mat('#212121'), 0, -2.5);
      add(new THREE.BoxGeometry(0.6, 2, 2.2), new THREE.MeshBasicMaterial({ color: '#ff1744' }), 5.6);
      break;
    }
    case 'hubwagen': {
      add(new THREE.BoxGeometry(10, 1.2, 1.2), mat('#c62828'), 4);
      add(new THREE.BoxGeometry(1.2, 5, 1.2), mat('#212121'), 0);
      break;
    }
    case 'stapler': { // Fernbedienung
      add(new THREE.BoxGeometry(4, 5, 2), mat('#f9a825'), 1);
      add(new THREE.CylinderGeometry(0.3, 0.3, 6, 6), mat('#424242'), 1, 5);
      add(new THREE.SphereGeometry(0.8, 6, 6), new THREE.MeshBasicMaterial({ color: '#ff1744' }), 1, 8);
      break;
    }
    case 'gas': {
      add(new THREE.CylinderGeometry(2.4, 2.4, 8, 10), mat('#c62828', { metalness: 0.4 }), 1);
      add(new THREE.CylinderGeometry(0.9, 0.9, 2.5, 6), mat('#9e9e9e', { metalness: 0.8 }), 1, 5);
      break;
    }
    case 'palette': { // Funkgerät zum Kranführer
      add(new THREE.BoxGeometry(3, 6, 2), mat('#263238'), 0.5, 1);
      add(new THREE.CylinderGeometry(0.4, 0.4, 5, 6), mat('#111'), 1.5, 6);
      break;
    }
    case 'inventur': { // Klemmbrett
      add(new THREE.BoxGeometry(6, 8, 0.6), mat('#8d6e63'), 2, 1);
      add(new THREE.BoxGeometry(5, 6.5, 0.7), mat('#fafafa'), 2, 0.6);
      break;
    }
    case 'karton': {
      add(new THREE.BoxGeometry(8, 6, 1), mat('#c99a62'), 3);
      add(new THREE.TorusGeometry(1.6, 0.7, 6, 12), mat('#e6d3a3'), 3, 0, 1.2);
      break;
    }
    case 'pause': { // Kaffeebecher
      add(new THREE.CylinderGeometry(1.8, 1.5, 4, 12), mat('#fafafa'), 1, 1);
      add(new THREE.CylinderGeometry(1.6, 1.6, 0.3, 12), mat('#4e342e'), 1, 3);
      const handle = add(new THREE.TorusGeometry(1, 0.35, 6, 10), mat('#fafafa'), -1, 1);
      handle.rotation.y = Math.PI / 2;
      break;
    }
    case 'sendung': { // Rohr mit blauem Expresspaket und Antenne
      const tube = add(new THREE.CylinderGeometry(2.2, 2.6, 12, 12), mat('#455a64', { metalness: 0.6, roughness: 0.4 }), 3);
      tube.rotation.z = Math.PI / 2;
      add(new THREE.BoxGeometry(4, 4, 4), mat('#1e88e5'), 9.5);
      add(new THREE.CylinderGeometry(0.3, 0.3, 5, 6), mat('#111'), 2, 4);
      add(new THREE.SphereGeometry(0.7, 6, 6), new THREE.MeshBasicMaterial({ color: '#00e5ff' }), 2, 6.5);
      break;
    }
    case 'retoure': {
      add(new THREE.BoxGeometry(6, 5, 5), mat('#c99a62'), 1.5);
      add(new THREE.BoxGeometry(6.2, 1.2, 5.2), mat('#e53935'), 1.5, 0.5);
      break;
    }
    case 'fass': {
      add(new THREE.CylinderGeometry(3, 3, 7, 12), mat('#fbc02d', { metalness: 0.3 }), 1.5);
      add(new THREE.CylinderGeometry(3.1, 3.1, 1.2, 12), mat('#212121'), 1.5, 1.2);
      break;
    }
    case 'tacker': {
      add(new THREE.BoxGeometry(8, 3, 2.5), mat('#e65100'), 3);
      add(new THREE.BoxGeometry(2.2, 5, 2), mat('#212121'), 0.5, -2.5);
      add(new THREE.BoxGeometry(1, 1.5, 2.6), mat('#b0bec5', { metalness: 0.8 }), 7.2, -0.8);
      break;
    }
    case 'stempel': { // großer Firmenstempel
      add(new THREE.CylinderGeometry(1, 1, 5, 8), mat('#5d4037'), 1, 0);
      const pad = add(new THREE.BoxGeometry(7, 2.5, 5), mat('#c62828'), 1, 3.5);
      pad.rotation.z = 0;
      break;
    }
    case 'drohne': { // Tablet als Fernsteuerung
      add(new THREE.BoxGeometry(6, 4.5, 0.8), mat('#263238'), 1.5, 1);
      add(new THREE.BoxGeometry(5, 3.5, 0.9), new THREE.MeshBasicMaterial({ color: '#4fc3f7' }), 1.5, 1);
      break;
    }
    case 'tresor': { // Funkgerät zum Kran
      add(new THREE.BoxGeometry(3, 6, 2), mat('#37474f'), 0.5, 1);
      add(new THREE.CylinderGeometry(0.4, 0.4, 5, 6), mat('#111'), 1.5, 6);
      add(new THREE.SphereGeometry(0.6, 6, 6), new THREE.MeshBasicMaterial({ color: '#ffd400' }), 1.5, 8.6);
      break;
    }
    case 'bohrer': { // Bohrhammer
      add(new THREE.BoxGeometry(6, 4, 3.5), mat('#fdd835'), 2);
      const bit = add(new THREE.CylinderGeometry(0.7, 0.3, 8, 6), mat('#9e9e9e', { metalness: 0.9, roughness: 0.3 }), 9);
      bit.rotation.z = Math.PI / 2;
      break;
    }
    case 'seil':
    case 'seilhand': { // Ratsche mit orangem Spanngurt
      add(new THREE.BoxGeometry(4, 3, 3), mat('#78909c', { metalness: 0.7, roughness: 0.4 }), 1);
      if (id === 'seil') add(new THREE.CylinderGeometry(2.6, 2.6, 2.4, 12), mat('#ff8f00'), 1, 2.6).rotation.x = Math.PI / 2;
      break;
    }
    case 'rucksack': {
      add(new THREE.CylinderGeometry(2, 2, 7, 10), mat('#90a4ae', { metalness: 0.7, roughness: 0.3 }), 1);
      add(new THREE.CylinderGeometry(1.3, 1.3, 0.6, 10), mat('#fafafa'), 1, 3.8).rotation.x = Math.PI / 2;
      break;
    }
    case 'fallschirm': add(new THREE.BoxGeometry(6, 4, 4), mat('#1976d2'), 1.5); break;
    case 'expander': {
      add(new THREE.TorusGeometry(2.6, 0.8, 6, 14), mat('#e53935'), 2);
      add(new THREE.BoxGeometry(1, 3, 1), mat('#b0bec5', { metalness: 0.8 }), 5, -1);
      break;
    }
    case 'empty': break;
    default: add(new THREE.BoxGeometry(5, 3, 3), mat('#333'));
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// Kündigungs-Karton als Grabstein
function makeGraveMesh(teamColor) {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(12, 13, 9), mat('#a77b47'));
  box.position.y = 6.5;
  const tape = new THREE.Mesh(new THREE.BoxGeometry(12.2, 2, 9.2), mat(teamColor));
  tape.position.y = 9;
  const red = mat('#d32f2f', { emissive: '#d32f2f', emissiveIntensity: 0.3 });
  const x1 = new THREE.Mesh(new THREE.BoxGeometry(9, 1.4, 0.4), red);
  x1.position.set(0, 4.5, 4.7); x1.rotation.z = 0.6;
  const x2 = x1.clone(); x2.rotation.z = -0.6;
  const flap = new THREE.Mesh(new THREE.BoxGeometry(6, 0.8, 9), mat('#8d6a3f'));
  flap.position.set(-4, 13.5, 0); flap.rotation.z = 0.5;
  g.add(box, tape, x1, x2, flap);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function makeProjectileMesh(type) {
  const g = new THREE.Group();
  if (type === 'paket') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(11, 8, 8), mat('#b98b54')));
    const tape = new THREE.Mesh(new THREE.BoxGeometry(2.5, 8.2, 8.2), mat('#e6d3a3'));
    g.add(tape);
  } else if (type === 'folie') {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 10, 14),
      new THREE.MeshPhysicalMaterial({ color: '#cfe8ff', transparent: true, opacity: 0.75, roughness: 0.1, transmission: 0.3 })));
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 11, 8), mat('#8a6236')));
  } else if (type === 'kiste') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(10, 7, 7), mat('#1565c0')));
  } else if (type === 'frag') {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 5, 6), mat('#b0bec5', { metalness: 0.8, roughness: 0.3 })));
  } else if (type === 'stapler') {
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(16, 8, 10), mat('#f9a825'));
    chassis.position.x = -2;
    g.add(chassis);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(8, 9, 9), mat('#212121', { transparent: true, opacity: 0.6 }));
    cab.position.set(-3, 8, 0);
    const mast = new THREE.Mesh(new THREE.BoxGeometry(1.5, 20, 8), mat('#424242'));
    mast.position.set(7, 6, 0);
    const fork = new THREE.Mesh(new THREE.BoxGeometry(10, 1, 6), mat('#616161'));
    fork.position.set(12, -3, 0);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 11, 12), mat('#111'));
    wheel.rotation.x = Math.PI / 2; wheel.position.set(-6, -4, 0);
    const wheel2 = wheel.clone(); wheel2.position.x = 4;
    g.add(cab, mast, fork, wheel, wheel2);
    g.userData.wheels = [wheel, wheel2];
    g.userData.fork = fork;
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff9100' }));
    beacon.position.set(-3, 13.5, 0);
    g.add(beacon);
    g.userData.beacon = beacon;
  } else if (type === 'gas') {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 13, 14), mat('#c62828', { metalness: 0.4, roughness: 0.4 })));
    const valve = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 4, 8), mat('#9e9e9e', { metalness: 0.8 }));
    valve.position.y = 8;
    g.add(valve);
  } else if (type === 'sendung') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(11, 8, 8), mat('#1e88e5')));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(2.5, 8.2, 8.2), mat('#ffd400')));
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 7, 6), mat('#111'));
    ant.position.set(-3, 6, 0);
    const led = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 6), new THREE.MeshBasicMaterial({ color: '#00e5ff' }));
    led.position.set(-3, 9.5, 0);
    g.add(ant, led);
    g.userData.led = led;
  } else if (type === 'retoure' || type === 'retoure2') {
    const k = type === 'retoure' ? 1 : 0.7;
    g.add(new THREE.Mesh(new THREE.BoxGeometry(11 * k, 9 * k, 9 * k), mat('#c99a62')));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(11.2 * k, 2 * k, 9.2 * k), mat('#e53935')));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(2 * k, 9.2 * k, 9.2 * k), mat('#e53935')));
  } else if (type === 'fass') {
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 14, 16), mat('#fbc02d', { metalness: 0.3, roughness: 0.5 })));
    for (const y of [-4, 4]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.2, 1.2, 16), mat('#212121'));
      ring.position.y = y;
      g.add(ring);
    }
    const sign = new THREE.Mesh(new THREE.CircleGeometry(3, 3), new THREE.MeshBasicMaterial({ color: '#d50000' }));
    sign.position.z = 6.1;
    g.add(sign);
  } else if (type === 'drohne') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(10, 3, 8), mat('#eceff1')));
    const cam = new THREE.Mesh(new THREE.SphereGeometry(1.8, 8, 6), mat('#212121'));
    cam.position.set(4, -2, 0);
    g.add(cam);
    const props = [];
    for (const [x, z] of [[-6, -5], [6, -5], [-6, 5], [6, 5]]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat('#455a64'));
      arm.position.set(x * 0.6, 1, z * 0.6);
      const prop = new THREE.Mesh(new THREE.BoxGeometry(8, 0.4, 1.2), mat('#263238'));
      prop.position.set(x, 2.5, z);
      g.add(arm, prop);
      props.push(prop);
    }
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.9, 6, 6), new THREE.MeshBasicMaterial({ color: '#ff1744' }));
    led.position.set(-5, 1, 0);
    g.add(led);
    g.userData.props = props;
    g.userData.led = led;
  } else if (type === 'tresor') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(20, 22, 16), mat('#455a64', { metalness: 0.6, roughness: 0.45 })));
    const door = new THREE.Mesh(new THREE.BoxGeometry(16, 18, 1), mat('#546e7a', { metalness: 0.7, roughness: 0.35 }));
    door.position.z = 8.2;
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 1.5, 16), mat('#cfd8dc', { metalness: 0.9, roughness: 0.2 }));
    dial.rotation.x = Math.PI / 2; dial.position.set(0, 2, 9);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(1.5, 6, 1.5), mat('#cfd8dc', { metalness: 0.9 }));
    handle.position.set(5, -4, 9.2);
    g.add(door, dial, handle);
  } else if (type === 'palette') {
    const wood = mat('#c8a165');
    for (let i = -1; i <= 1; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(26, 1.5, 5), wood);
      slat.position.set(0, 2, i * 7);
      g.add(slat);
      const block = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 18), wood);
      block.position.set(i * 10, 0, 0);
      g.add(block);
    }
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ---------- Renderer ----------
export class Renderer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('WebGL-Kontext verloren – warte auf Wiederherstellung');
    });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#10131a');
    this.scene.fog = new THREE.Fog('#10131a', 800, 2300);

    this.camera = new THREE.PerspectiveCamera(45, 1, 10, 6000);
    this.camPos = new THREE.Vector3(W / 2, H / 2, 1100);
    this.camTarget = new THREE.Vector3(W / 2, H / 2, 0);
    this.zoom = 900;

    this.buildLights();
    this.buildHall();
    this.buildWater();

    this.workerMeshes = new Map();
    this.labels = new Map();
    this.labelLayer = document.getElementById('labels');
    this.projectileMeshes = [];
    this.particles = [];
    this.flashes = [];
    this.terrainMesh = null;

    // Fadenkreuz & Ladebalken
    this.crosshair = new THREE.Mesh(new THREE.RingGeometry(4, 6, 20), new THREE.MeshBasicMaterial({ color: '#ff1744' }));
    this.crosshair.position.z = 12;
    this.crosshair.visible = false;
    this.scene.add(this.crosshair);
    this.chargeBar = new THREE.Mesh(new THREE.PlaneGeometry(1, 4), new THREE.MeshBasicMaterial({ color: '#ff9100' }));
    this.chargeBar.visible = false;
    this.scene.add(this.chargeBar);
    // Zielmarkierung für Klick-Waffen
    this.targetMarker = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(10, 13, 32), new THREE.MeshBasicMaterial({ color: '#00e5ff', transparent: true, opacity: 0.9 }));
    this.targetMarker.add(ring);
    this.targetMarker.visible = false;
    this.scene.add(this.targetMarker);
    this.girderGhost = new THREE.Mesh(new THREE.BoxGeometry(GIRDER_LEN, GIRDER_THICK, 14),
      new THREE.MeshBasicMaterial({ color: '#d6aa6e', transparent: true, opacity: 0.55 }));
    this.girderGhost.visible = false;
    this.scene.add(this.girderGhost);
    // Laser
    this.lasers = [];
    this.rings = [];

    this.shake = 0;
    this.time = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight('#c9d6ff', '#3a2c1c', 1.1));
    const sun = new THREE.DirectionalLight('#fff4e0', 2.0);
    sun.position.set(W / 2 + 400, H + 900, 900);
    sun.target.position.set(W / 2, H / 2, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -W / 2 - 200; sc.right = W / 2 + 200; sc.top = H / 2 + 400; sc.bottom = -H / 2 - 400;
    sc.near = 100; sc.far = 3500;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun, sun.target);
  }

  // Hochregallager im Hintergrund
  buildHall() {
    const rng = mulberry32(42);
    const hall = new THREE.Group();
    // Rückwand und Boden
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(W * 4, H * 3), mat('#2a2f3a'));
    wall.position.set(W / 2, H / 2 + 300, -1500);
    hall.add(wall);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W * 4, 2000), mat('#3a3d42'));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, ty(WATER_Y) - 40, -800);
    floor.receiveShadow = true;
    hall.add(floor);
    // Fensterband
    for (let i = 0; i < 14; i++) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(220, 90), new THREE.MeshBasicMaterial({ color: '#7fa7d9' }));
      win.position.set(-1400 + i * 400, H + 500, -1490);
      hall.add(win);
    }
    // Regalreihen: blaue Stützen, orange Träger, Kartons per InstancedMesh
    const uprightGeo = new THREE.BoxGeometry(8, 1, 8);
    const beamGeo = new THREE.BoxGeometry(1, 7, 6);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const uprightMat = mat('#1a3a73');
    const beamMat = mat('#9c4a1a');
    const rows = [-520, -880, -1200];
    const maxBoxes = 2600;
    const boxes = new THREE.InstancedMesh(boxGeo, mat('#8a8a8a'), maxBoxes);
    boxes.castShadow = false;
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    let bi = 0;
    const floorY = ty(WATER_Y) - 40;
    const boxColors = ['#b98b54', '#a77b47', '#c99a62', '#8d6a3f', '#d9c7a3', '#3c6fb6', '#cfd8dc'];
    const uprightM = [];
    const beamM = [];
    for (const z of rows) {
      const levels = 6;
      const levelH = 170;
      const bay = 260;
      for (let x = -1600; x <= W + 1600; x += bay) {
        for (const dz of [-40, 40]) {
          uprightM.push(new THREE.Matrix4().makeScale(1, levels * levelH, 1).setPosition(x, floorY + (levels * levelH) / 2, z + dz));
        }
        for (let l = 1; l <= levels; l++) {
          const y = floorY + l * levelH - 20;
          for (const dz of [-40, 40]) {
            beamM.push(new THREE.Matrix4().makeScale(bay, 1, 1).setPosition(x + bay / 2, y, z + dz));
          }
          // Waren auf dem Fach
          let bx = x + 12;
          while (bx < x + bay - 30 && bi < maxBoxes) {
            const bw = 30 + rng() * 50, bh = 30 + rng() * 90, bd = 50 + rng() * 30;
            if (bx + bw > x + bay - 8) break;
            if (rng() < 0.85) {
              m4.makeScale(bw, bh, bd);
              m4.setPosition(bx + bw / 2, y + 3.5 + bh / 2, z);
              boxes.setMatrixAt(bi, m4);
              col.set(boxColors[Math.floor(rng() * boxColors.length)]);
              boxes.setColorAt(bi, col);
              bi++;
            }
            bx += bw + 4 + rng() * 10;
          }
        }
      }
    }
    for (const [geo, material, list] of [[uprightGeo, uprightMat, uprightM], [beamGeo, beamMat, beamM]]) {
      const im = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      hall.add(im);
    }
    boxes.count = bi;
    boxes.instanceMatrix.needsUpdate = true;
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
    hall.add(boxes);
    // Hallenleuchten
    for (let i = 0; i < 8; i++) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(160, 6, 30), new THREE.MeshBasicMaterial({ color: '#fffbe6' }));
      lamp.position.set(-600 + i * 520, H + 650, -350);
      hall.add(lamp);
    }
    this.scene.add(hall);
  }

  buildWater() {
    const geo = new THREE.PlaneGeometry(W * 4, 900, 160, 1);
    const m = new THREE.MeshStandardMaterial({ color: '#0d4a6b', transparent: true, opacity: 0.88, roughness: 0.2, metalness: 0.1, emissive: '#06283a', emissiveIntensity: 0.6 });
    this.water = new THREE.Mesh(geo, m);
    this.water.position.set(W / 2, ty(WATER_Y) - 450, 30);
    this.waterY = WATER_Y;
    this.waterShown = WATER_Y;
    this.waterBase = Float32Array.from(geo.attributes.position.array);
    this.scene.add(this.water);
    // Kaikante als Hinweis
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W * 4, 900), new THREE.MeshStandardMaterial({ color: '#0a3550', roughness: 0.3 }));
    back.position.set(W / 2, ty(WATER_Y) - 455, -60);
    this.scene.add(back);
    this.waterBack = back;
  }

  // Sudden Death: Hafenbecken steigt (weich animiert).
  setWaterLevel(y, instant = false) {
    this.waterY = y;
    if (instant) this.waterShown = y;
    this.water.position.y = ty(this.waterShown) - 450;
    this.waterBack.position.y = ty(this.waterShown) - 455;
  }

  setTerrain(terrain) {
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
      this.terrainMesh.material.dispose();
    }
    if (this.terrainBack) {
      this.scene.remove(this.terrainBack);
      this.terrainBack.children.forEach((c) => c.material.dispose());
    }
    const geo = new THREE.PlaneGeometry(W, H);
    const m = new THREE.MeshStandardMaterial({ map: terrain.texture, transparent: true, alphaTest: 0.5, roughness: 0.9, side: THREE.DoubleSide });
    this.terrainMesh = new THREE.Mesh(geo, m);
    this.terrainMesh.position.set(W / 2, H / 2, 0);
    this.terrainMesh.receiveShadow = true;
    this.scene.add(this.terrainMesh);
    // Abgedunkelte Kopien dahinter geben dem Gelände Tiefe.
    this.terrainBack = new THREE.Group();
    for (let i = 1; i <= 3; i++) {
      const back = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: terrain.texture, transparent: true, alphaTest: 0.5, color: new THREE.Color().setScalar(0.45 - i * 0.08) }));
      back.position.set(W / 2, H / 2, -i * 4);
      this.terrainBack.add(back);
    }
    this.scene.add(this.terrainBack);
  }

  // ---------- Arbeiter ----------
  // held: { id, aimArm } – Gegenstand in der Hand des aktiven Arbeiters
  syncWorkers(workers, teams, activeId, held = null, charge = 0, dt = 1 / 60) {
    const seen = new Set();
    for (const w of workers) {
      seen.add(w.id);
      let mesh = this.workerMeshes.get(w.id);
      if (!mesh) {
        mesh = makeWorkerMesh(teams[w.team]?.color || '#fff');
        this.workerMeshes.set(w.id, mesh);
        this.scene.add(mesh);
        const el = document.createElement('div');
        el.className = 'wlabel';
        el.innerHTML = '<span class="n"></span><span class="hp"></span>';
        el.style.setProperty('--team', teams[w.team]?.color || '#fff');
        this.labelLayer.appendChild(el);
        this.labels.set(w.id, el);
      }
      const el = this.labels.get(w.id);
      mesh.visible = !w.dead && w.x != null;
      el.style.display = mesh.visible ? '' : 'none';
      if (!mesh.visible) continue;
      const ry = w.ry ?? w.y;
      mesh.position.set(tx(w.rx ?? w.x), ty(ry) - 1, 6);
      const isActive = w.id === activeId;
      this.animateWorker(mesh, w, ry, isActive ? held : null, isActive ? charge : 0, dt);
      el.querySelector('.n').textContent = w.name;
      el.querySelector('.hp').textContent = Math.max(0, Math.round(w.hp));
      el.classList.toggle('active', isActive);
      el.dataset.x = mesh.position.x;
      el.dataset.y = mesh.position.y + 22;
    }
    for (const [id, mesh] of this.workerMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.workerMeshes.delete(id);
        this.labels.get(id)?.remove();
        this.labels.delete(id);
      }
    }
  }

  animateWorker(mesh, w, ry, held, charge, dt) {
    const ud = mesh.userData;
    const st = ud.st;
    const t = this.time + st.phase;
    // Vertikalgeschwindigkeit aus der Darstellung (funktioniert auch bei Zuschauern)
    if (st.lastY != null && dt > 0) st.vy += ((ry - st.lastY) / dt - st.vy) * Math.min(1, dt * 12);
    st.lastY = ry;
    const air = w.grounded === false;
    const facing = w.facing < 0 ? -1 : 1;

    // Gegenstand in der Hand
    const heldId = held?.id || null;
    if (ud.heldId !== heldId) {
      ud.holder.clear();
      ud.holder.add(heldId ? makeHeldMesh(heldId) : ud.tool);
      ud.heldId = heldId;
    }

    // Abklingende Zustände
    st.squash = Math.max(0, st.squash - dt * 4);
    st.hurt = Math.max(0, st.hurt - dt * 2.5);
    st.dizzy = Math.max(0, st.dizzy - dt);
    if (st.act) { st.actT += dt; }
    const actDur = { shoot: 0.3, throw: 0.4, swing: 0.45, drop: 0.5, tele: 0.5, build: 0.6, coffee: 1.8, radio: 1.2, flip: 0.7, uppercut: 0.55, drill: 0.15 }[st.act] || 0;
    if (st.act && st.actT > actDur) st.act = null;
    const ak = st.act ? st.actT / actDur : 0; // 0..1 Fortschritt der Aktion

    // Grundpose
    let poseRot = 0, poseX = 0, poseY = 0, sx = 1, sy = 1;
    let legL = 0, legR = 0, armB = 0.25, headRot = 0;
    let armRot = held?.armAngle != null ? held.armAngle : held?.aimArm ? -(w.aim || 0) : (held ? -0.9 : -(w.aim || 0) * 0.3 - 0.6);
    let armX = 1;

    if (air) {
      // Fliegen/Fallen: Beine spreizen, Arm rudert, beim Fallen hektischer
      const falling = st.vy < -60;
      legL = falling ? 0.6 + Math.sin(t * 22) * 0.3 : 0.5;
      legR = falling ? -0.5 - Math.sin(t * 22) * 0.3 : -0.2;
      armB = 2.6 + Math.sin(t * (falling ? 24 : 12)) * 0.6;
      poseRot = falling ? Math.sin(t * 9) * 0.18 : 0.08;
      headRot = falling ? 0.25 : 0;
    } else if (w.walking) {
      const ph = this.time * 18 + st.phase;
      const s1 = Math.sin(ph);
      legL = s1 * 0.6; legR = -s1 * 0.6;
      armB = -s1 * 0.5 + 0.1;
      poseY = Math.abs(Math.cos(ph)) * 1.2;
      poseRot = -0.06;
    } else {
      // Stehen: atmen, ab und zu umschauen
      sy = 1 + Math.sin(t * 2.4) * 0.02;
      headRot = Math.sin(t * 0.7) > 0.93 ? 0.15 : Math.sin(t * 0.5) * 0.04;
      armB = 0.15 + Math.sin(t * 2.4) * 0.04;
    }

    // Aufladen: zittern, Arm zurückziehen
    if (charge > 0) {
      poseX += (Math.random() - 0.5) * charge * 1.4;
      armX = 1 - charge * 2;
      sy *= 1 - charge * 0.05;
    }

    // Aktionen (Schuss, Wurf, Schlag, ...)
    switch (st.act) {
      case 'shoot': armX -= Math.sin(ak * Math.PI) * 3; armRot += Math.sin(ak * Math.PI) * 0.35; poseRot += Math.sin(ak * Math.PI) * 0.08; break;
      case 'throw': armRot += ak < 0.3 ? 2.2 * (ak / 0.3) : 2.2 * (1 - (ak - 0.3) / 0.25); poseRot -= Math.sin(ak * Math.PI) * 0.15; break;
      case 'swing': poseX += Math.sin(ak * Math.PI) * 7; poseRot -= Math.sin(ak * Math.PI) * 0.3; armRot = -0.1; break;
      case 'drop': poseRot -= Math.sin(ak * Math.PI) * 0.5; armRot = -1.3; break;
      case 'tele': { const k = Math.sin(ak * Math.PI); sx *= 1 - k * 0.7; sy *= 1 + k * 0.6; break; }
      case 'build': armRot = -0.3 + Math.abs(Math.sin(ak * Math.PI * 4)) * 0.8; break;
      case 'coffee': armRot = 1.6; headRot = -0.35; armX = -1; break;
      case 'radio': armRot = 1.9; armX = -0.5; headRot = 0.1; break;
      case 'flip': if (air) poseRot += ak * Math.PI * 2; break;
      case 'uppercut': armRot = ak < 0.25 ? -1.2 + ak * 4 * 2.9 : 1.7; poseRot += Math.sin(ak * Math.PI) * 0.25; sy *= 1 + Math.sin(ak * Math.PI) * 0.12; break;
      case 'drill': poseX += (Math.random() - 0.5) * 1.6; poseY += (Math.random() - 0.5) * 1.2; headRot += (Math.random() - 0.5) * 0.2; break;
    }

    // Landung: zusammenstauchen
    if (st.squash > 0) { const k = st.squash; sy *= 1 - k * 0.28; sx *= 1 + k * 0.2; poseY -= k * 2; legL = 0.4 * k; legR = -0.4 * k; }
    // Treffer: zurückzucken, rot aufleuchten
    if (st.hurt > 0) {
      poseRot += st.hurt * 0.35; headRot += st.hurt * 0.4;
      ud.torsoMat.emissive.setRGB(0.4 + st.hurt * 0.6, 0.1 * (1 - st.hurt), 0.1 * (1 - st.hurt));
      ud.torsoMat.emissiveIntensity = 0.15 + st.hurt * 0.8;
    } else if (ud.torsoMat.emissiveIntensity !== 0.15) {
      ud.torsoMat.emissive.copy(ud.torsoMat.color);
      ud.torsoMat.emissiveIntensity = 0.15;
    }
    // Blinzeln
    st.blink -= dt;
    if (st.blink < -0.12) st.blink = 2 + Math.random() * 4;
    ud.eyes.scale.y = st.blink < 0 || st.dizzy > 0 ? 0.2 : 1;
    // Schwindel
    ud.stars.visible = st.dizzy > 0;
    if (st.dizzy > 0) { ud.stars.rotation.y += dt * 6; headRot += Math.sin(this.time * 7) * 0.12; }

    ud.body.scale.x = facing;
    ud.pose.rotation.z = poseRot;
    ud.pose.position.set(poseX, poseY, 0);
    ud.pose.scale.set(sx, sy, 1);
    ud.legL.rotation.z = legL;
    ud.legR.rotation.z = legR;
    ud.armB.rotation.z = armB;
    ud.arm.rotation.z = armRot;
    ud.arm.position.x = armX;
    ud.headG.rotation.z = headRot;
  }

  // Aktion eines Arbeiters abspielen (shoot, throw, swing, drop, tele, build, coffee, radio, flip)
  workerAnim(id, act) {
    const m = this.workerMeshes.get(id);
    if (!m) return;
    m.userData.st.act = act;
    m.userData.st.actT = 0;
  }

  workerHurt(id) {
    const m = this.workerMeshes.get(id);
    if (m) m.userData.st.hurt = 1;
  }

  workerLand(id, hard = false) {
    const m = this.workerMeshes.get(id);
    if (!m) return;
    m.userData.st.squash = hard ? 1 : 0.6;
    if (hard) m.userData.st.dizzy = 2.2;
  }

  // ---------- Grabsteine ----------
  syncGraves(graves, teams) {
    this.graveMeshes ||= new Map();
    const seen = new Set();
    for (const g of graves) {
      seen.add(g.id);
      let m = this.graveMeshes.get(g.id);
      if (!m) {
        m = makeGraveMesh(teams[g.team]?.color || '#fff');
        m.userData.spawn = 0;
        this.graveMeshes.set(g.id, m);
        this.scene.add(m);
      }
      m.userData.spawn = Math.min(1, m.userData.spawn + 0.05);
      const k = m.userData.spawn;
      m.scale.setScalar(1.5 * (k < 1 ? 0.3 + k * 0.8 - Math.sin(k * Math.PI) * 0.1 : 1));
      m.position.set(tx(g.x), ty(g.y) - 6, 4);
      m.rotation.z = g.tilt || 0;
    }
    for (const [id, m] of this.graveMeshes) {
      if (!seen.has(id)) { this.scene.remove(m); this.graveMeshes.delete(id); }
    }
  }

  clearWorkers() {
    for (const mesh of this.workerMeshes.values()) this.scene.remove(mesh);
    for (const el of this.labels.values()) el.remove();
    this.workerMeshes.clear();
    this.labels.clear();
  }

  // ---------- Projektile ----------
  setProjectiles(list, dt = 1 / 60) {
    // list: [{type, x, y, rot, facing, fuse}]
    this.fuseLabels ||= [];
    while (this.projectileMeshes.length > list.length) {
      const m = this.projectileMeshes.pop();
      this.scene.remove(m);
    }
    let fl = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      let m = this.projectileMeshes[i];
      if (!m || m.userData.type !== p.type) {
        if (m) this.scene.remove(m);
        m = makeProjectileMesh(p.type);
        m.userData.type = p.type;
        m.userData.trail = 0;
        this.projectileMeshes[i] = m;
        this.scene.add(m);
      }
      m.position.set(tx(p.x), ty(p.y), 6);
      m.rotation.z = -(p.rot || 0);
      m.scale.x = p.facing < 0 ? -1 : 1;
      const ud = m.userData;
      // Kleine Animationen je Projektil
      if (p.type === 'stapler') {
        for (const wh of ud.wheels) wh.rotation.y += dt * 14;
        ud.fork.position.y = -3 + Math.sin(this.time * 6) * 1.2;
        ud.beacon.material.color.setHSL(0.08, 1, Math.sin(this.time * 14) > 0 ? 0.55 : 0.2);
        m.position.y += Math.abs(Math.sin(this.time * 25)) * 0.6; // Motor rüttelt
      } else if (p.type === 'drohne') {
        for (const pr of ud.props) pr.rotation.y += dt * 40;
        ud.led.visible = Math.sin(this.time * 12) > 0;
        m.scale.y = Math.cos(p.rot || 0) < 0 ? -1 : 1; // nicht kopfüber fliegen
      } else if (p.type === 'sendung') {
        ud.led.visible = Math.sin(this.time * 20) > 0;
      } else if (p.type === 'fass') {
        m.rotation.z = -(p.rot || 0) * 0.3;
      }
      ud.trail += dt;
      if (p.type === 'paket' && ud.trail > 0.035) {
        ud.trail = 0;
        this.smokePuff(p.x, p.y, '#9e9e9e', 2.2);
      } else if (p.type === 'gas' && ud.trail > 0.09) {
        ud.trail = 0;
        this.smokePuff(p.x + (Math.random() - 0.5) * 3, p.y - 9, '#eceff1', 1.6, 70);
      } else if (p.type === 'sendung' && ud.trail > 0.03) {
        ud.trail = 0;
        this.smokePuff(p.x, p.y, '#80deea', 2);
      } else if (p.type === 'tresor' && ud.trail > 0.05) {
        ud.trail = 0;
        this.smokePuff(p.x + (Math.random() - 0.5) * 16, p.y - 12, '#b0bec5', 2.5, 10);
      } else if (p.type === 'palette' && ud.trail > 0.08) {
        ud.trail = 0;
        this.smokePuff(p.x, p.y - 6, '#d7ccc8', 1.2);
      }
      // Zünder-Countdown
      if (p.fuse != null && p.fuse > 0) {
        let el = this.fuseLabels[fl];
        if (!el) {
          el = document.createElement('div');
          el.className = 'fuse';
          this.labelLayer.appendChild(el);
          this.fuseLabels[fl] = el;
        }
        const sec = Math.ceil(p.fuse);
        if (el.textContent !== String(sec)) el.textContent = sec;
        el.classList.toggle('hot', sec <= 1);
        el.style.display = '';
        const pp = this.project(tx(p.x), ty(p.y) + 16);
        el.style.transform = `translate(${pp.x}px, ${pp.y}px) translate(-50%, -100%)`;
        fl++;
      }
    }
    for (let i = fl; i < this.fuseLabels.length; i++) this.fuseLabels[i].style.display = 'none';
  }

  smokePuff(x, y, color, size = 2, rise = 30) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 5),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false }));
    p.position.set(tx(x), ty(y), 5);
    this.addParticle(p, (Math.random() - 0.5) * 15, rise * (0.5 + Math.random()), 0, 0.7, false, true);
  }

  // Staub beim Landen
  dust(x, y, amount = 1) {
    const n = Math.round(6 + amount * 10);
    for (let i = 0; i < n; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(1.5 + Math.random() * 2.5 * amount, 6, 5),
        new THREE.MeshBasicMaterial({ color: Math.random() < 0.5 ? '#bcaaa4' : '#a1887f', transparent: true, opacity: 0.7, depthWrite: false }));
      p.position.set(tx(x), ty(y), 10);
      const dir = i % 2 ? 1 : -1;
      this.addParticle(p, dir * (40 + Math.random() * 90 * amount), 10 + Math.random() * 40, 0, 0.6 + Math.random() * 0.4, false, true);
    }
    this.shake = Math.min(18, this.shake + amount * 4);
  }

  // ---------- Effekte ----------
  explosion(x, y, r) {
    const pos = new THREE.Vector3(tx(x), ty(y), 10);
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: '#ffb300', transparent: true, opacity: 1, depthWrite: false }),
    );
    flash.position.copy(pos);
    this.scene.add(flash);
    const light = new THREE.PointLight('#ff9100', 60000, r * 10, 2);
    light.position.copy(pos).setZ(60);
    this.scene.add(light);
    this.flashes.push({ mesh: flash, light, t: 0, r });
    // Druckwelle
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40),
      new THREE.MeshBasicMaterial({ color: '#fff3e0', transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.copy(pos).setZ(14);
    this.scene.add(ring);
    this.rings.push({ mesh: ring, t: 0, r });
    // Trümmer: Kartonfetzen, Styropor, Schrauben
    const colors = ['#b98b54', '#8a6236', '#eeeeee', '#555', '#ffcc80'];
    const n = Math.min(40, 10 + r * 0.5);
    for (let i = 0; i < n; i++) {
      const s = 1.5 + Math.random() * 4;
      const p = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.6, s), mat(colors[i % colors.length]));
      p.position.copy(pos);
      const a = Math.random() * Math.PI * 2;
      const sp = 150 + Math.random() * 350;
      this.addParticle(p, Math.cos(a) * sp, Math.sin(a) * sp + 150, (Math.random() - 0.5) * 300, 1.2 + Math.random(), true);
    }
    for (let i = 0; i < 8; i++) {
      const smoke = new THREE.Mesh(new THREE.SphereGeometry(r * 0.25, 10, 8),
        new THREE.MeshBasicMaterial({ color: '#444', transparent: true, opacity: 0.5, depthWrite: false }));
      smoke.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * r, (Math.random() - 0.5) * r, 5));
      this.addParticle(smoke, (Math.random() - 0.5) * 30, 40 + Math.random() * 40, 0, 1.5 + Math.random(), false, true);
    }
    this.shake = Math.min(18, this.shake + r * 0.18);
  }

  splash(x) {
    const pos = new THREE.Vector3(tx(x), ty(this.waterY), 32);
    for (let i = 0; i < 20; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(2 + Math.random() * 2, 6, 6),
        new THREE.MeshBasicMaterial({ color: '#9fd3f5', transparent: true, opacity: 0.85 }));
      p.position.copy(pos);
      this.addParticle(p, (Math.random() - 0.5) * 200, 150 + Math.random() * 250, 0, 1, true);
    }
  }

  puff(x, y, color = '#cfe8ff') {
    for (let i = 0; i < 12; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(2 + Math.random() * 3, 6, 6),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }));
      p.position.set(tx(x), ty(y), 12);
      const a = Math.random() * Math.PI * 2;
      this.addParticle(p, Math.cos(a) * 80, Math.sin(a) * 80, 0, 0.7, false, true);
    }
  }

  laser(x1, y1, x2, y2, color = '#ff1744') {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(tx(x1), ty(y1), 12), new THREE.Vector3(tx(x2), ty(y2), 12),
    ]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: color || '#ff1744', transparent: true }));
    this.scene.add(line);
    this.lasers.push({ line, t: 0 });
  }

  addParticle(mesh, vx, vy, vr, life, gravity, grow = false) {
    this.scene.add(mesh);
    this.particles.push({ mesh, vx, vy, vr, life, max: life, gravity, grow });
    if (this.particles.length > 400) {
      const old = this.particles.shift();
      this.disposeObj(old.mesh);
    }
  }

  disposeObj(m) {
    this.scene.remove(m);
    m.geometry?.dispose();
    m.material?.dispose?.();
  }

  // ---------- Hilfsmittel (Spanngurt, Expander, Rucksack, Fallschirm) ----------
  // g: {k, on, p:[x,y,...], x, y, facing} oder null
  showGear(g, dt = 1 / 60) {
    if (!this.gear) {
      const gear = new THREE.Group();
      this.scene.add(gear);
      const strapMat = mat('#ff8f00', { roughness: 0.6 });
      const rubberMat = mat('#c62828', { roughness: 0.5 });
      const hook = new THREE.Group();
      const hk = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.8, 6, 12, Math.PI * 1.4), mat('#b0bec5', { metalness: 0.9, roughness: 0.3 }));
      hook.add(hk);
      gear.add(hook);
      // Druckluft-Rucksack: zwei Flaschen + Flamme
      const pack = new THREE.Group();
      for (const z of [-2.2, 2.2]) {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 10, 10), mat('#90a4ae', { metalness: 0.7, roughness: 0.3 }));
        tank.position.z = z;
        pack.add(tank);
      }
      const flame = new THREE.Mesh(new THREE.ConeGeometry(2.6, 12, 10), new THREE.MeshBasicMaterial({ color: '#e3f2fd', transparent: true, opacity: 0.85, depthWrite: false }));
      flame.rotation.z = Math.PI; flame.position.y = -11;
      pack.add(flame);
      gear.add(pack);
      // Fallschirm aus Lagerplane
      const chute = new THREE.Group();
      const canopy = new THREE.Mesh(new THREE.SphereGeometry(30, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2.6),
        mat('#29b6f6', { side: THREE.DoubleSide, roughness: 0.8, emissive: '#0d47a1', emissiveIntensity: 0.25 }));
      canopy.scale.y = 0.5;
      canopy.position.y = 52;
      chute.add(canopy);
      const lineMat = new THREE.LineBasicMaterial({ color: '#eeeeee' });
      for (const x of [-25, -9, 9, 25]) {
        chute.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 4, 0), new THREE.Vector3(x, 52, 0)]), lineMat));
      }
      gear.add(chute);
      this.gear = { group: gear, segs: [], strapMat, rubberMat, hook, pack, flame, chute, chuteSway: 0 };
    }
    const G = this.gear;
    const k = g?.k;
    G.pack.visible = k === 'jet';
    G.chute.visible = k === 'chute';
    const pts = (k === 'rope' || k === 'bungee') && g.p ? g.p : null;
    G.hook.visible = !!pts && k === 'rope';
    let used = 0;
    if (pts) {
      // Gurt vom Anker über die Knickpunkte bis zur Hand
      const chain = [];
      for (let i = 0; i < pts.length; i += 2) chain.push([pts[i], pts[i + 1]]);
      chain.push([g.x, g.y - 2]);
      for (let i = 0; i < chain.length - 1; i++) {
        let m = G.segs[used];
        if (!m) {
          m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), G.strapMat);
          m.castShadow = true;
          G.group.add(m);
          G.segs[used] = m;
        }
        const [ax, ay] = chain[i], [bx, by] = chain[i + 1];
        const len = Math.hypot(bx - ax, by - ay);
        m.material = k === 'bungee' ? G.rubberMat : G.strapMat;
        const thick = k === 'bungee' ? (g.on ? 1.6 : 2.4) : 3;
        m.scale.set(Math.max(0.1, len), thick, k === 'bungee' ? thick : 1);
        m.position.set(tx((ax + bx) / 2), ty((ay + by) / 2), 6);
        m.rotation.z = Math.atan2(-(by - ay), bx - ax);
        m.visible = true;
        used++;
      }
      G.hook.position.set(tx(pts[0]), ty(pts[1]), 7);
      G.hook.rotation.z = this.time * (g.on ? 0 : 20);
    }
    for (let i = used; i < G.segs.length; i++) G.segs[i].visible = false;
    if (k === 'jet') {
      G.pack.position.set(tx(g.x - (g.facing < 0 ? -1 : 1) * 6), ty(g.y) + 3, 1);
      G.flame.visible = !!g.on;
      if (g.on) {
        G.flame.scale.set(1, 0.7 + Math.random() * 0.6, 1);
        if (Math.random() < dt * 30) this.smokePuff(g.x - (g.facing < 0 ? -1 : 1) * 6, g.y + 16, '#eceff1', 2, -40);
      }
    }
    if (k === 'chute') {
      G.chuteSway += dt;
      G.chute.position.set(tx(g.x), ty(g.y), 6);
      G.chute.rotation.z = Math.sin(G.chuteSway * 2) * 0.08;
    }
  }

  // ---------- Zielhilfen ----------
  showAim(worker, aim, facing, charge, visible) {
    this.crosshair.visible = visible;
    this.chargeBar.visible = visible && charge > 0;
    if (!visible) return;
    const dx = Math.cos(aim) * facing, dy = Math.sin(aim);
    this.crosshair.position.set(tx(worker.x + dx * 60), ty(worker.y + dy * 60), 12);
    if (charge > 0) {
      const len = charge * 60;
      this.chargeBar.scale.x = len;
      this.chargeBar.position.set(tx(worker.x + dx * (len / 2 + 10)), ty(worker.y + dy * (len / 2 + 10)), 11);
      this.chargeBar.rotation.z = Math.atan2(-dy, dx);
      this.chargeBar.material.color.setHSL(0.12 - charge * 0.12, 1, 0.5);
    }
  }

  showTarget(kind, x, y, angle) {
    this.targetMarker.visible = kind === 'point';
    this.girderGhost.visible = kind === 'girder';
    if (kind === 'point') this.targetMarker.position.set(tx(x), ty(y), 14);
    if (kind === 'girder') {
      this.girderGhost.position.set(tx(x), ty(y), 6);
      this.girderGhost.rotation.z = -angle;
    }
  }

  // ---------- Kamera ----------
  screenToWorld(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const t = -ray.ray.origin.z / ray.ray.direction.z;
    const p = ray.ray.origin.clone().add(ray.ray.direction.clone().multiplyScalar(t));
    return { x: p.x, y: H - p.y };
  }

  worldPerPixel() {
    const h = 2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.camPos.z;
    return h / (this.renderer.domElement.clientHeight || 1);
  }

  frame(dt, focus) {
    this.time += dt;
    // Kamera weich zum Fokus
    if (focus) {
      const fx = Math.max(-200, Math.min(W + 200, focus.x));
      const fy = Math.max(100, Math.min(H + 150, ty(focus.y)));
      const k = 1 - Math.exp(-dt * 4);
      this.camTarget.x += (fx - this.camTarget.x) * k;
      this.camTarget.y += (fy - this.camTarget.y) * k;
    }
    this.camPos.z += (this.zoom - this.camPos.z) * (1 - Math.exp(-dt * 6));
    // Nebel relativ zur Kamera: Spielfeld bleibt klar, die Halle dahinter verblasst.
    this.scene.fog.near = this.camPos.z + 200;
    this.scene.fog.far = this.camPos.z + 1500;
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    this.shake *= Math.exp(-dt * 6);
    this.camera.position.set(this.camTarget.x + sx, this.camTarget.y + 60 + sy, this.camPos.z);
    this.camera.lookAt(this.camTarget.x + sx * 0.5, this.camTarget.y + sy * 0.5, 0);

    if (Math.abs(this.waterShown - this.waterY) > 0.1) {
      this.waterShown += (this.waterY - this.waterShown) * (1 - Math.exp(-dt * 1.5));
      this.water.position.y = ty(this.waterShown) - 450;
      this.waterBack.position.y = ty(this.waterShown) - 455;
    }
    // Wasserwellen
    const pos = this.water.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const by = this.waterBase[i * 3 + 1];
      if (by > 0) {
        const x = this.waterBase[i * 3];
        pos.array[i * 3 + 1] = by + Math.sin(x * 0.02 + this.time * 2) * 4 + Math.sin(x * 0.007 - this.time * 1.3) * 3;
      }
    }
    pos.needsUpdate = true;

    // Partikel
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.disposeObj(p.mesh); this.particles.splice(i, 1); continue; }
      if (p.gravity) p.vy -= 700 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vr * dt * 0.1;
      p.mesh.rotation.x += p.vr * dt * 0.05;
      p.mesh.rotation.y += p.vr * dt * 0.03;
      if (p.grow) {
        p.mesh.scale.multiplyScalar(1 + dt * 1.5);
        p.mesh.material.opacity = 0.5 * (p.life / p.max);
      } else if (p.mesh.material.transparent) {
        p.mesh.material.opacity = Math.min(1, p.life / p.max * 2);
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = f.t / 0.35;
      if (k >= 1) {
        this.disposeObj(f.mesh); this.scene.remove(f.light); f.light.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      f.mesh.scale.setScalar(f.r * (0.4 + k * 0.9));
      f.mesh.material.opacity = 1 - k;
      f.mesh.material.color.setHSL(0.12 - k * 0.1, 1, 0.6 - k * 0.3);
      f.light.intensity = 60000 * (1 - k);
    }
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const l = this.lasers[i];
      l.t += dt;
      l.line.material.opacity = 1 - l.t / 0.4;
      if (l.t > 0.4) { this.disposeObj(l.line); this.lasers.splice(i, 1); }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / 0.4;
      if (k >= 1) { this.disposeObj(r.mesh); this.rings.splice(i, 1); continue; }
      r.mesh.scale.setScalar(r.r * (0.3 + k * 1.6));
      r.mesh.material.opacity = 0.8 * (1 - k);
    }
    this.targetMarker.rotation.z += dt * 2;

    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  }

  project(x3, y3) {
    const v = new THREE.Vector3(x3, y3, 6).project(this.camera);
    const el = this.renderer.domElement;
    return { x: (v.x * 0.5 + 0.5) * el.clientWidth, y: (-v.y * 0.5 + 0.5) * el.clientHeight };
  }

  updateLabels() {
    for (const el of this.labels.values()) {
      if (el.style.display === 'none') continue;
      const p = this.project(+el.dataset.x, +el.dataset.y);
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    }
  }

  // Schadenszahlen als HTML
  floatText(x, y, text, color) {
    const p = this.project(tx(x), ty(y) + 26);
    const el = document.createElement('div');
    el.className = 'floattext';
    el.textContent = text;
    el.style.color = color;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    this.labelLayer.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }
}

export { WORKER_R };
