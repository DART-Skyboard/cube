/*
 * LEATR Live Cube — a small embeddable view of the Session Cube live feed.
 *
 * Drop onto any page:
 *   <div data-live-cube style="width:506px;height:506px"></div>
 *   <script src="https://cube.leatr.xyz/live-cube.js" defer></script>
 *
 * Optional attributes on the element:
 *   data-size="5"                      window edge in cells (default 5)
 *   data-href="https://cube.leatr.xyz" where a click goes
 *   data-target="_blank"               link target (default _blank)
 *
 * It polls the same journal read the Session Cube uses and shows a
 * size³ window of the live maze that follows the newest step along the
 * path: frosted red walls, blue path, slow turntable. Purely visual —
 * clicking opens the full Session Cube.
 */
(function () {
  "use strict";

  var GAS =
    "https://script.google.com/macros/s/AKfycbyzkQxLR5miUXP6oDw-1AR1GIjgpzlw9iLw0gO_ZTeLfL849LWbNX7WVz_kf7yLWBKA_w/exec";
  var THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r132/three.min.js";
  var POLL_MS = 5000;
  var SPIN = 0.14; // rad/s turntable
  var WALL = "#e0473c";
  var PATH = "#3aa8ff";
  var HEAD = "#bfe6ff";

  var FACES = {
    left: [-1, 0, 0],
    right: [1, 0, 0],
    bottom: [0, -1, 0],
    top: [0, 1, 0],
    back: [0, 0, -1],
    front: [0, 0, 1],
  };
  // Faces a neighbor inside the window also draws; skip ours to avoid doubling.
  var OWNED_BY_NEIGHBOR = { right: 1, top: 1, front: 1 };

  function withThree(cb) {
    if (window.THREE && window.THREE.InstancedMesh) return cb(window.THREE);
    var s = document.createElement("script");
    s.src = THREE_URL;
    s.onload = function () {
      cb(window.THREE);
    };
    document.head.appendChild(s);
  }

  function readLive(path) {
    var url = GAS + "?action=ashread&path=" + encodeURIComponent(path) + "&t=" + Date.now();
    return fetch(url, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("proxy");
        return res.json();
      })
      .then(function (body) {
        if (body == null) return null;
        if (body.ok === false) throw new Error(body.error || "unread");
        if (body.ok === true && "content" in body) return body.content;
        return body;
      });
  }

  function fetchLive() {
    return readLive("ashtree/analytics-live/config.json").then(function (config) {
      if (!config || !config.enabled || !config.mazeId) return null;
      return readLive("ashtree/analytics-live/" + config.mazeId + "/latest-export.json").then(function (raw) {
        return raw && typeof raw === "object" && raw.cube && raw.cube.cells ? raw : null;
      });
    });
  }

  // A small random maze + walk so the cube is never empty while waiting.
  function demoRaw(n) {
    var cells = {};
    var key = function (x, y, z) {
      return x + "," + y + "," + z;
    };
    var all = [];
    for (var x = 0; x < n; x++)
      for (var y = 0; y < n; y++)
        for (var z = 0; z < n; z++) {
          var c = { x: x, y: y, z: z, walls: { left: true, right: true, top: true, bottom: true, front: true, back: true } };
          cells[key(x, y, z)] = c;
          all.push(c);
        }
    var opposite = { left: "right", right: "left", top: "bottom", bottom: "top", front: "back", back: "front" };
    var seen = {};
    var stack = [cells[key(0, 0, 0)]];
    var path = [];
    seen[key(0, 0, 0)] = 1;
    while (stack.length) {
      var cur = stack[stack.length - 1];
      path.push({ order: path.length, x: cur.x, y: cur.y, z: cur.z, events: [] });
      var options = [];
      for (var f in FACES) {
        var d = FACES[f];
        var nk = key(cur.x + d[0], cur.y + d[1], cur.z + d[2]);
        if (cells[nk] && !seen[nk]) options.push([f, cells[nk]]);
      }
      if (!options.length) {
        stack.pop();
        continue;
      }
      var pick = options[Math.floor(Math.random() * options.length)];
      cur.walls[pick[0]] = false;
      pick[1].walls[opposite[pick[0]]] = false;
      seen[key(pick[1].x, pick[1].y, pick[1].z)] = 1;
      stack.push(pick[1]);
    }
    return {
      cube: { width: n, height: n, depth: n, cells: all },
      totalEvents: 0,
      exportedAt: "demo",
      mode: "DEMO",
      pathIndex: [{ layer: 0, path: path.slice(0, Math.floor(path.length * 0.6)) }],
    };
  }

  function flattenPath(raw) {
    var out = [];
    (raw.pathIndex || []).forEach(function (layer) {
      (layer.path || []).forEach(function (node) {
        out.push(node);
      });
    });
    out.sort(function (a, b) {
      return a.order - b.order;
    });
    return out;
  }

  // Pick the n³ window that contains the newest path step, clamped to the maze.
  function windowFor(raw, path, n) {
    var cube = raw.cube;
    var head = path[path.length - 1] || { x: 0, y: 0, z: 0 };
    var lo = function (v, dim) {
      return Math.max(0, Math.min(Math.max(0, dim - n), v - Math.floor(n / 2)));
    };
    return {
      x: lo(head.x, cube.width),
      y: lo(head.y, cube.height),
      z: lo(head.z, cube.depth),
      nx: Math.min(n, cube.width),
      ny: Math.min(n, cube.height),
      nz: Math.min(n, cube.depth),
    };
  }

  function ditherTexture(THREE) {
    // 4×4 Bayer pattern → frosted, dithered look on the wall panels.
    var bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    var px = 32;
    var cv = document.createElement("canvas");
    cv.width = cv.height = px;
    var g = cv.getContext("2d");
    var img = g.createImageData(px, px);
    for (var y = 0; y < px; y++)
      for (var x = 0; x < px; x++) {
        var t = bayer[(y % 4) * 4 + (x % 4)] / 16;
        var edge = x < 2 || y < 2 || x > px - 3 || y > px - 3;
        var i = (y * px + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = edge ? 255 : t < 0.45 ? 200 : 40;
      }
    g.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  }

  function mount(el, THREE) {
    var n = Math.max(2, Math.min(10, parseInt(el.getAttribute("data-size") || "5", 10) || 5));
    var href = el.getAttribute("data-href") || "https://cube.leatr.xyz";
    var target = el.getAttribute("data-target") || "_blank";

    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.style.cursor = "pointer";
    el.setAttribute("role", "link");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", "Open the LEATR Session Cube");
    el.title = "Open the LEATR Session Cube";

    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    el.appendChild(renderer.domElement);

    var badge = document.createElement("div");
    badge.style.cssText =
      "position:absolute;left:10px;bottom:8px;font:600 11px/1.2 ui-monospace,Menlo,monospace;" +
      "letter-spacing:.08em;color:#bfe6ff;text-shadow:0 1px 3px #000;pointer-events:none;display:flex;gap:6px;align-items:center";
    var dot = document.createElement("span");
    dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:#8ea39a;display:inline-block";
    var label = document.createElement("span");
    label.textContent = "SESSION CUBE";
    badge.appendChild(dot);
    badge.appendChild(label);
    el.appendChild(badge);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, n * 1.15, n * 3.0);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    var sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(3, 6, 4);
    scene.add(sun);

    var turntable = new THREE.Group();
    turntable.rotation.x = 0.18;
    scene.add(turntable);
    var content = new THREE.Group();
    turntable.add(content);

    var wallMat = new THREE.MeshBasicMaterial({
      color: WALL,
      map: ditherTexture(THREE),
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    var pathMat = new THREE.MeshStandardMaterial({ color: PATH, emissive: PATH, emissiveIntensity: 0.55, roughness: 0.4 });
    var headMat = new THREE.MeshStandardMaterial({ color: HEAD, emissive: PATH, emissiveIntensity: 1.2 });
    var linkMat = new THREE.LineBasicMaterial({ color: PATH, transparent: true, opacity: 0.7 });
    var frameMat = new THREE.LineBasicMaterial({ color: WALL, transparent: true, opacity: 0.35 });
    var wallGeo = new THREE.PlaneGeometry(0.92, 0.92);
    var nodeGeo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
    var headGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    var head = null;
    var lastKey = "";

    function clear() {
      while (content.children.length) {
        var child = content.children.pop();
        if (child.geometry && child.geometry !== wallGeo && child.geometry !== nodeGeo && child.geometry !== headGeo)
          child.geometry.dispose();
        if (child.dispose) child.dispose();
      }
      head = null;
    }

    function build(raw) {
      var path = flattenPath(raw);
      var w = windowFor(raw, path, n);
      var inWin = function (c) {
        return c.x >= w.x && c.x < w.x + w.nx && c.y >= w.y && c.y < w.y + w.ny && c.z >= w.z && c.z < w.z + w.nz;
      };
      var cx = w.x + (w.nx - 1) / 2;
      var cy = w.y + (w.ny - 1) / 2;
      var cz = w.z + (w.nz - 1) / 2;
      clear();

      // Walls
      var faces = [];
      raw.cube.cells.forEach(function (cell) {
        if (!inWin(cell) || !cell.walls) return;
        for (var f in FACES) {
          if (!cell.walls[f]) continue;
          var d = FACES[f];
          if (OWNED_BY_NEIGHBOR[f] && inWin({ x: cell.x + d[0], y: cell.y + d[1], z: cell.z + d[2] })) continue;
          faces.push([cell.x - cx + d[0] * 0.5, cell.y - cy + d[1] * 0.5, cell.z - cz + d[2] * 0.5, d]);
        }
      });
      if (faces.length) {
        var walls = new THREE.InstancedMesh(wallGeo, wallMat, faces.length);
        var m = new THREE.Object3D();
        faces.forEach(function (f, i) {
          m.position.set(f[0], f[1], f[2]);
          m.rotation.set(0, 0, 0);
          if (f[3][0]) m.rotation.y = Math.PI / 2;
          else if (f[3][1]) m.rotation.x = Math.PI / 2;
          m.updateMatrix();
          walls.setMatrixAt(i, m.matrix);
        });
        content.add(walls);
      }

      // Path: runs of consecutive steps inside the window.
      var nodes = path.filter(inWin);
      if (nodes.length) {
        var dots = new THREE.InstancedMesh(nodeGeo, pathMat, nodes.length);
        var o = new THREE.Object3D();
        nodes.forEach(function (p, i) {
          o.position.set(p.x - cx, p.y - cy, p.z - cz);
          o.updateMatrix();
          dots.setMatrixAt(i, o.matrix);
        });
        content.add(dots);
        var pts = [];
        for (var i = 1; i < path.length; i++) {
          var a = path[i - 1];
          var b = path[i];
          if (!inWin(a) || !inWin(b)) continue;
          if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) !== 1) continue;
          pts.push(new THREE.Vector3(a.x - cx, a.y - cy, a.z - cz), new THREE.Vector3(b.x - cx, b.y - cy, b.z - cz));
        }
        if (pts.length) content.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), linkMat));
        var last = path[path.length - 1];
        if (last && inWin(last)) {
          head = new THREE.Mesh(headGeo, headMat);
          head.position.set(last.x - cx, last.y - cy, last.z - cz);
          content.add(head);
        }
      }

      content.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w.nx, w.ny, w.nz)), frameMat));
    }

    function setStatus(live, text) {
      dot.style.background = live ? "#3aa8ff" : "#8ea39a";
      dot.style.boxShadow = live ? "0 0 8px #3aa8ff" : "none";
      label.textContent = text;
    }

    var hasLive = false;
    function poll() {
      fetchLive()
        .then(function (raw) {
          if (!raw) {
            setStatus(false, hasLive ? "SESSION CUBE \u00b7 PAUSED" : "SESSION CUBE");
            return;
          }
          hasLive = true;
          setStatus(true, "LIVE \u00b7 " + (raw.totalEvents || 0) + " EVENTS");
          var key = raw.exportedAt + "|" + raw.totalEvents + "|" + flattenPath(raw).length;
          if (key === lastKey) return;
          lastKey = key;
          build(raw);
        })
        .catch(function () {
          setStatus(false, hasLive ? "SESSION CUBE \u00b7 RECONNECTING" : "SESSION CUBE");
        });
    }
    build(demoRaw(n));
    poll();
    var timer = setInterval(function () {
      if (!document.hidden) poll();
    }, POLL_MS);

    function resize() {
      var r = el.getBoundingClientRect();
      var width = Math.max(1, r.width);
      var height = Math.max(1, r.height || r.width);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(el);
    else window.addEventListener("resize", resize);

    var visible = true;
    if (window.IntersectionObserver)
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
      }).observe(el);

    var prev = performance.now();
    function frame(now) {
      var dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      if (visible && !document.hidden) {
        turntable.rotation.y += SPIN * dt;
        if (head) {
          var s = 1 + Math.sin(now / 320) * 0.12;
          head.scale.set(s, s, s);
        }
        renderer.render(scene, camera);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    function go() {
      window.open(href, target, target === "_blank" ? "noopener" : undefined);
    }
    el.addEventListener("click", go);
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
    el._liveCubeStop = function () {
      clearInterval(timer);
    };
  }

  function start() {
    var els = document.querySelectorAll("[data-live-cube]");
    if (!els.length) return;
    withThree(function (THREE) {
      for (var i = 0; i < els.length; i++) {
        if (els[i]._liveCubeMounted) continue;
        els[i]._liveCubeMounted = true;
        mount(els[i], THREE);
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
