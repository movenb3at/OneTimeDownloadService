import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createTimeline, onScroll } from "animejs";

const TAU = Math.PI * 2;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (value) => {
  const v = clamp(value);
  return v * v * (3 - 2 * v);
};

export function createCore() {
  const canvas = document.getElementById("core-canvas");
  const container = document.querySelector(".scene");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
  } catch {
    container.dataset.mode = "static";
    return null;
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
  camera.position.set(7, 4.5, 10);
  camera.lookAt(0, 0, 0);
  renderer.setClearColor(0x101311, 0);
  renderer.setPixelRatio(
    Math.min(devicePixelRatio, innerWidth < 700 ? 1.2 : 1.7),
  );
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;
  const environment = new RoomEnvironment();
  const generator = new THREE.PMREMGenerator(renderer);
  const envTexture = generator.fromScene(environment, 0.04);
  scene.environment = envTexture.texture;
  environment.dispose();
  generator.dispose();
  scene.add(new THREE.HemisphereLight(0xdaebd3, 0x132218, 2.0));
  const light = new THREE.DirectionalLight(0xf2f9e9, 4.5);
  light.position.set(4, 6, 8);
  scene.add(light);
  const rimLight = new THREE.DirectionalLight(0xa5ea73, 3);
  rimLight.position.set(-5, 1, -4);
  scene.add(rimLight);

  const materials = {
    shell: new THREE.MeshStandardMaterial({
      color: 0x38453b,
      metalness: 0.88,
      roughness: 0.32,
    }),
    metal: new THREE.MeshStandardMaterial({
      color: 0xa2aba0,
      metalness: 0.92,
      roughness: 0.25,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: 0x101a13,
      metalness: 0.65,
      roughness: 0.4,
    }),
    green: new THREE.MeshStandardMaterial({
      color: 0xb5e68e,
      emissive: 0x4a7429,
      emissiveIntensity: 0.5,
      metalness: 0.3,
      roughness: 0.3,
    }),
    glow: new THREE.MeshBasicMaterial({ color: 0xb8f68c }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x90a681,
      transparent: true,
      opacity: 0.09,
      metalness: 0.2,
      roughness: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  };
  const rig = new THREE.Group();
  scene.add(rig);
  const body = new THREE.Group();
  rig.add(body);
  function mesh(geometry, material, parent = body) {
    const result = new THREE.Mesh(geometry, material);
    parent.add(result);
    return result;
  }
  function ring(radius, tube, z, material, parent = body) {
    const result = mesh(
      new THREE.TorusGeometry(radius, tube, 8, 96),
      material,
      parent,
    );
    result.position.z = z;
    return result;
  }
  function cylinder(radius, length, z, material, parent = body) {
    const result = mesh(
      new THREE.CylinderGeometry(radius, radius, length, 64),
      material,
      parent,
    );
    result.rotation.x = Math.PI / 2;
    result.position.z = z;
    return result;
  }
  function radialInstances(
    geometry,
    material,
    count,
    radius,
    z,
    parent,
    scale = 1,
  ) {
    const instance = new THREE.InstancedMesh(geometry, material, count);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TAU;
      dummy.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
      dummy.rotation.set(0, 0, angle);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      instance.setMatrixAt(i, dummy.matrix);
    }
    parent.add(instance);
    return instance;
  }

  // Six machined shell sectors, each with its own rail and fasteners.
  const shells = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i * TAU) / 6;
    const shell = new THREE.Group();
    const shape = new THREE.Shape();
    const start = -0.43,
      end = 0.43;
    shape.absarc(0, 0, 1.75, start, end, false);
    shape.absarc(0, 0, 1.57, end, start, true);
    shape.closePath();
    const segment = mesh(
      new THREE.ExtrudeGeometry(shape, {
        depth: 2.8,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.035,
        bevelThickness: 0.035,
        curveSegments: 12,
      }),
      materials.shell,
      shell,
    );
    segment.position.z = -1.4;
    for (const y of [-0.46, 0.46]) {
      const rail = mesh(
        new THREE.BoxGeometry(0.08, 0.06, 2.92),
        materials.metal,
        shell,
      );
      rail.position.set(1.72, y, 0);
      for (const z of [-1.22, 0, 1.22]) {
        const screw = mesh(
          new THREE.CylinderGeometry(0.055, 0.055, 0.1, 6),
          materials.dark,
          shell,
        );
        screw.rotation.z = Math.PI / 2;
        screw.position.set(1.79, y, z);
      }
    }
    const stripe = mesh(
      new THREE.BoxGeometry(0.025, 0.055, 1.45),
      materials.green,
      shell,
    );
    stripe.position.set(1.8, 0, 0);
    shell.rotation.z = angle;
    body.add(shell);
    shells.push({ group: shell, angle });
  }

  const front = new THREE.Group(),
    back = new THREE.Group();
  body.add(front, back);
  for (const [assembly, z] of [
    [front, 1.58],
    [back, -1.58],
  ]) {
    ring(1.57, 0.11, z, materials.metal, assembly);
    ring(1.35, 0.035, z + Math.sign(z) * 0.08, materials.green, assembly);
    ring(1.72, 0.035, z, materials.dark, assembly);
    radialInstances(
      new THREE.BoxGeometry(0.12, 0.2, 0.16),
      materials.shell,
      24,
      1.62,
      z,
      assembly,
    );
    radialInstances(
      new THREE.CylinderGeometry(0.045, 0.045, 0.14, 6).rotateX(Math.PI / 2),
      materials.metal,
      12,
      1.62,
      z + Math.sign(z) * 0.12,
      assembly,
    );
  }
  const chamber = new THREE.Group();
  body.add(chamber);
  const spine = cylinder(0.28, 3.5, 0, materials.dark, chamber);
  spine.position.y = -0.9;
  for (const z of [-1.1, 1.1]) {
    ring(1.08, 0.04, z, materials.metal, chamber);
    radialInstances(
      new THREE.BoxGeometry(0.7, 0.035, 0.035),
      materials.dark,
      6,
      0.83,
      z,
      chamber,
    );
  }
  const glass = mesh(
    new THREE.BoxGeometry(1.35, 1.7, 1.35),
    materials.glass,
    chamber,
  );
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x89b476,
    transparent: true,
    opacity: 0.4,
  });
  chamber.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(glass.geometry),
      edgeMaterial,
    ),
  );

  const file = new THREE.Group();
  chamber.add(file);
  const paper = new THREE.Shape();
  paper.moveTo(-0.45, -0.62);
  paper.lineTo(0.45, -0.62);
  paper.lineTo(0.45, 0.37);
  paper.lineTo(0.17, 0.65);
  paper.lineTo(-0.45, 0.65);
  paper.closePath();
  const pageGeometry = new THREE.ExtrudeGeometry(paper, {
    depth: 0.045,
    bevelEnabled: true,
    bevelSize: 0.035,
    bevelThickness: 0.018,
    bevelSegments: 2,
    steps: 1,
  });
  for (let i = 2; i >= 0; i--) {
    const page = mesh(
      pageGeometry,
      i === 0 ? materials.green : materials.dark,
      file,
    );
    page.position.set(i * -0.07, i * -0.045, -i * 0.14);
  }
  for (let i = 0; i < 3; i++) {
    const line = mesh(
      new THREE.BoxGeometry(i === 2 ? 0.32 : 0.55, 0.03, 0.016),
      materials.dark,
      file,
    );
    line.position.set(i === 2 ? -0.1 : 0, 0.12 - i * 0.16, 0.096);
  }
  // A solid download arrow in the face of the central file.
  const arrow = new THREE.Shape();
  arrow.moveTo(-0.055, -0.2);
  arrow.lineTo(0.055, -0.2);
  arrow.lineTo(0.055, -0.38);
  arrow.lineTo(0.17, -0.38);
  arrow.lineTo(0, -0.53);
  arrow.lineTo(-0.17, -0.38);
  arrow.lineTo(-0.055, -0.38);
  arrow.closePath();
  const arrowMesh = mesh(new THREE.ShapeGeometry(arrow), materials.dark, file);
  arrowMesh.position.z = 0.108;

  const timer = new THREE.Group();
  body.add(timer);
  ring(2.05, 0.025, 0, materials.metal, timer);
  ring(2.12, 0.012, 0, materials.green, timer);
  radialInstances(
    new THREE.BoxGeometry(0.09, 0.018, 0.025),
    materials.green,
    60,
    2.04,
    0,
    timer,
  );
  radialInstances(
    new THREE.BoxGeometry(0.18, 0.04, 0.03),
    materials.metal,
    12,
    2.01,
    0,
    timer,
  );
  const scanner = new THREE.Group();
  body.add(scanner);
  ring(1.2, 0.035, 0, materials.glow, scanner);
  ring(1.27, 0.008, 0, materials.metal, scanner);
  radialInstances(
    new THREE.BoxGeometry(0.035, 0.12, 0.025),
    materials.green,
    16,
    1.23,
    0,
    scanner,
  );

  const panels = [];
  for (let i = 0; i < 3; i++) {
    const panel = new THREE.Group();
    body.add(panel);
    mesh(new THREE.BoxGeometry(0.8, 0.5, 0.06), materials.dark, panel);
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(0.8, 0.5, 0.06)),
      edgeMaterial,
    );
    panel.add(outline);
    for (let j = 0; j < 4; j++) {
      const bar = mesh(
        new THREE.BoxGeometry(0.06, 0.06 + j * 0.055, 0.015),
        materials.green,
        panel,
      );
      bar.position.set(-0.23 + j * 0.15, -0.11 + j * 0.02, 0.045);
    }
    panels.push(panel);
  }
  const path = new THREE.Group();
  body.add(path);
  const pathLine = mesh(
    new THREE.BoxGeometry(0.018, 0.018, 5),
    materials.green,
    path,
  );
  pathLine.position.z = 3.2;
  const nodes = [];
  for (let i = 0; i < 5; i++)
    nodes.push(mesh(new THREE.OctahedronGeometry(0.075), materials.glow, path));

  const state = { stage: 0 };
  const pointer = { x: 0, y: 0 };
  let frame = 0,
    disposed = false,
    inView = true,
    renderCount = 0;
  function render() {
    frame = 0;
    if (disposed || document.hidden || !inView) {
      frame = 0;
      return;
    }
    const s = state.stage;
    const opening = smooth(s) * (1 - smooth(s - 4));
    const timerReveal = smooth(s - 1) * (1 - smooth(s - 2.4));
    const verifyReveal = smooth(s - 2) * (1 - smooth(s - 3.4));
    const panelReveal = smooth(s - 3) * (1 - smooth(s - 4));
    const transmission = smooth(s - 4);
    const expansion = opening * (1.1 + panelReveal * 0.7);
    rig.rotation.x += (pointer.y * 0.08 - rig.rotation.x) * 0.08;
    rig.rotation.y += (pointer.x * 0.1 - rig.rotation.y) * 0.08;
    body.rotation.set(
      0.1 + Math.sin(s * 1.3) * 0.18,
      -0.25 + s * 0.5,
      0.15 - s * 0.16,
    );
    for (const { group, angle } of shells) {
      group.position.set(
        Math.cos(angle) * expansion,
        Math.sin(angle) * expansion,
        0,
      );
      group.rotation.z = angle + opening * 0.07;
    }
    front.position.z = opening * 1.0;
    back.position.z = -opening * 0.8;
    file.rotation.y = 0.2 + s * 0.32;
    timer.visible = timerReveal > 0.01;
    timer.scale.setScalar(0.75 + timerReveal * 0.4);
    timer.rotation.set(0.3 * timerReveal, 0.5 * timerReveal, s * 0.6);
    scanner.visible = verifyReveal > 0.01;
    scanner.position.z = (s - 2.5) * 3;
    scanner.rotation.z = s * 1.5;
    materials.green.emissiveIntensity = 0.5 + verifyReveal * 0.8;
    panels.forEach((panel, i) => {
      panel.visible = panelReveal > 0.01;
      const angle = (i * TAU) / 3 + 0.4;
      panel.position.set(
        Math.cos(angle) * (2.1 + panelReveal),
        Math.sin(angle) * (2.1 + panelReveal),
        0.4 + i * 0.3,
      );
      panel.rotation.set(0, -0.25, angle + Math.PI / 2);
    });
    path.visible = transmission > 0.01;
    path.scale.z = 0.3 + transmission * 0.7;
    nodes.forEach((node, i) => {
      node.position.z = 0.8 + i * 0.9;
      node.rotation.z = s * 0.8;
    });
    const scale = (innerWidth < 700 ? 0.92 : 1) * (1 - opening * 0.13);
    body.scale.setScalar(scale);
    const pullback = 1 + opening * 0.04;
    camera.position.set(7 * pullback, 4.5 + Math.sin(s) * 0.25, 10 * pullback);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    canvas.dataset.stage = s.toFixed(3);
    canvas.dataset.frames = String(++renderCount);
    if (
      Math.abs(rig.rotation.x - pointer.y * 0.08) +
        Math.abs(rig.rotation.y - pointer.x * 0.1) >
      0.0001
    )
      frame = requestAnimationFrame(render);
  }
  function resume() {
    if (!frame && !disposed && !document.hidden && inView)
      frame = requestAnimationFrame(render);
  }
  function pause() {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  function resize() {
    const rect = canvas.getBoundingClientRect();
    renderer.setPixelRatio(
      Math.min(devicePixelRatio, innerWidth < 700 ? 1.2 : 1.7),
    );
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
    resume();
  }
  const scroll = onScroll({
    target: "#story",
    enter: "top top",
    leave: "bottom bottom",
    sync: true,
    onUpdate: resume,
  });
  const timeline = createTimeline({
    autoplay: scroll,
    defaults: { ease: "linear" },
    onUpdate: resume,
  });
  timeline.add(state, { stage: 5, duration: 5000 }, 0);
  // Text enters with the same native scrolling used for the model.
  const textTimelines = [
    ...document.querySelectorAll(".story-section:not(.hero) .section-content"),
  ].map((target) =>
    createTimeline({
      autoplay: onScroll({
        target,
        enter: "bottom top+=80",
        leave: "center center",
        sync: true,
      }),
    }).add(target, {
      opacity: [0.35, 1],
      y: [25, 0],
      duration: 1000,
      ease: "outQuad",
    }),
  );
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  const intersection = new IntersectionObserver((entries) => {
    inView = entries[0].isIntersecting;
    if (inView) resume();
    else pause();
  });
  intersection.observe(document.getElementById("story"));
  function visibility() {
    if (document.hidden) pause();
    else resume();
  }
  function move(event) {
    if (matchMedia("(pointer: fine)").matches) {
      pointer.x = (event.clientX / innerWidth) * 2 - 1;
      pointer.y = (event.clientY / innerHeight) * 2 - 1;
      resume();
    }
  }
  function resetPointer() {
    pointer.x = pointer.y = 0;
    resume();
  }
  function lost(event) {
    event.preventDefault();
    dispose();
  }
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("pointerleave", resetPointer);
  canvas.addEventListener("webglcontextlost", lost);
  resize();
  resume();
  container.dataset.mode = "webgl";
  function dispose() {
    if (disposed) return;
    disposed = true;
    pause();
    timeline.revert();
    scroll.revert();
    for (const textTimeline of textTimelines) textTimeline.revert();
    resizeObserver.disconnect();
    intersection.disconnect();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pointermove", move);
    document.removeEventListener("pointerleave", resetPointer);
    canvas.removeEventListener("webglcontextlost", lost);
    const geometries = new Set(),
      usedMaterials = new Set();
    scene.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) usedMaterials.add(object.material);
    });
    geometries.forEach((geometry) => geometry.dispose());
    usedMaterials.forEach((material) => material.dispose());
    envTexture.dispose();
    renderer.dispose();
    container.dataset.mode = "static";
  }
  return {
    dispose,
    refresh: () => {
      // onScroll assigns its target on the next frame; language can change earlier.
      if (!disposed && scroll.target) scroll.container.refresh();
      if (!disposed) resize();
    },
  };
}
