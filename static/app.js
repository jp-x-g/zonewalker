/* 1680 Mission room map GUI */
"use strict";

const state = {
  floors: {},          // story -> {source, geojson}
  names: {},           // room_id(global) -> display name
  groups: {},          // gid -> {name, color, members: [globalId]}
  schemas: {},         // key -> {name, fields:[{key,label,type,options?}]}
  overlays: {},        // key -> {globalId -> {field: value}}
  activeSchemas: new Set(),
  mapShow: JSON.parse(localStorage.getItem("mapShow") || "{}"), // schemaKey -> fieldKey
  markers: {},          // schemaKey -> {mid: {floor, xy:[x,y], room, fields:{}}}
  placing: null,        // schemaKey while armed to drop a point
  selMarker: null,      // {key, mid}
  selection: new Set(),// globalIds like "F1/R010"
  colorby: "none",
};

const $ = (s) => document.querySelector(s);
const api = {
  get: (p) => fetch("/api/" + p).then((r) => r.json()),
  put: (p, body) =>
    fetch("/api/" + p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json()).then(() => flash("saved")),
};
let flashTimer;
function flash(msg) {
  $("#status").textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ($("#status").textContent = ""), 1200);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const saveNames = debounce(() => api.put("data/names", state.names), 600);
const saveGroups = debounce(() => api.put("data/groups", state.groups), 600);
const saveSchemas = debounce(() => api.put("data/schemas", state.schemas), 600);
function packOverlay(key) {
  return Object.assign({}, state.overlays[key] || {}, { _markers: state.markers[key] || {} });
}
async function loadOverlay(key) {
  const raw = await api.get("data/overlay_" + key);
  state.markers[key] = raw._markers || {};
  delete raw._markers;
  state.overlays[key] = raw;
}
const saveOverlay = debounce((key) => { api.put("data/overlay_" + key, packOverlay(key)); refreshLabels(); renderMarkers(); }, 600);

function roomLabel(gid) {
  return state.names[gid] || gid.split("/")[1];
}

/* ---------- rendering ---------- */
function renderMaps() {
  const maps = $("#maps");
  maps.innerHTML = "";
  const shown = [...document.querySelectorAll("#floor-checks input:checked")].map((c) => c.dataset.story);
  for (const story of shown) {
    const fl = state.floors[story];
    if (!fl) continue;
    const box = document.createElement("div");
    box.className = "floorbox";
    box.innerHTML = `<h4>Floor ${story}</h4>`;
    box.appendChild(buildFloorSvg(story, fl));
      maps.appendChild(box);
  }
  refreshRoomClasses();
  refreshLabels();
  renderMarkers();
}

function polyToPath(coords, tf) {
  return coords.map((ring) =>
    "M" + ring.map((p) => tf(p)).join("L") + "Z").join(" ");
}

function buildFloorSvg(story, fl) {
  const feats = fl.geojson.features;
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  const eachPt = (f, cb) => {
    const g = f.geometry;
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    polys.forEach((p) => p.forEach((ring) => ring.forEach(cb)));
  };
  feats.forEach((f) => eachPt(f, ([x, y]) => {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }));
  const pad = 20, W = maxx - minx + 2 * pad, H = maxy - miny + 2 * pad;
  const tf = ([x, y]) => `${(x - minx + pad).toFixed(1)},${(maxy - y + pad).toFixed(1)}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W.toFixed(0)} ${H.toFixed(0)}`);
  svg.dataset.story = story;
  svg.dataset.source = fl.source;
  svg.dataset.minx = minx; svg.dataset.maxy = maxy; svg.dataset.pad = pad;
  svg.addEventListener("click", (ev) => {
    if (!state.placing) return;
    ev.stopPropagation(); ev.preventDefault();
    const p = svgPoint(svg, ev);
    placeMarker(state.placing, fl, { x: p.x + minx - pad, y: maxy - (p.y - pad) });
  }, true);
  for (const f of feats) {
    const pr = f.properties;
    const gid = fl.source + "/" + pr.id;
    const g = f.geometry;
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    const d = polys.map((p) => polyToPath(p, tf)).join(" ");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill-rule", "evenodd");
    if (pr.type !== "room") {
      path.classList.add("nonroom");
    } else {
      path.classList.add("room");
      path.dataset.gid = gid;
      path.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!ev.ctrlKey && !ev.metaKey) state.selection.clear();
        if (state.selection.has(gid) && (ev.ctrlKey || ev.metaKey)) state.selection.delete(gid);
        else state.selection.add(gid);
        refreshRoomClasses(); renderSelection(); renderDataEditor();
      });
      const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      path.appendChild(t);
    }
    svg.appendChild(path);
  }
  for (const f of feats) {
    if (f.properties.type !== "room") continue;
    const gid = fl.source + "/" + f.properties.id;
    const [cx, cy] = centroid(f);
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.classList.add("roomlabel");
    t.dataset.gid = gid;
    t.setAttribute("x", (cx - minx + pad).toFixed(1));
    t.setAttribute("y", (maxy - cy + pad).toFixed(1));
    svg.appendChild(t);
  }
  const mg = document.createElementNS("http://www.w3.org/2000/svg", "g");
  mg.classList.add("markerlayer");
  svg.appendChild(mg);
  attachDragSelect(svg, fl, { minx, maxy, pad });
  return svg;
}

function attachDragSelect(svg, fl, frame) {
  let start = null, rect = null;
  svg.addEventListener("mousedown", (ev) => {
    if (ev.target.classList.contains("room")) return;
    start = svgPoint(svg, ev);
    rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.id = "selrect";
    svg.appendChild(rect);
    ev.preventDefault();
  });
  svg.addEventListener("mousemove", (ev) => {
    if (!start) return;
    const p = svgPoint(svg, ev);
    const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
    rect.setAttribute("x", x); rect.setAttribute("y", y);
    rect.setAttribute("width", Math.abs(p.x - start.x));
    rect.setAttribute("height", Math.abs(p.y - start.y));
  });
  window.addEventListener("mouseup", (ev) => {
    if (!start) return;
    const p = svgPoint(svg, ev);
    const x0 = Math.min(start.x, p.x), x1 = Math.max(start.x, p.x);
    const y0 = Math.min(start.y, p.y), y1 = Math.max(start.y, p.y);
    rect.remove();
    if (x1 - x0 > 6 && y1 - y0 > 6) {
      if (!ev.ctrlKey && !ev.metaKey) state.selection.clear();
      for (const f of fl.geojson.features) {
        if (f.properties.type !== "room") continue;
        const [cx, cy] = centroid(f);
        const sx = cx - frame.minx + frame.pad, sy = frame.maxy - cy + frame.pad;
        if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1)
          state.selection.add(fl.source + "/" + f.properties.id);
      }
      refreshRoomClasses(); renderSelection(); renderDataEditor();
    }
    start = null;
  });
}

function svgPoint(svg, ev) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function centroid(f) {
  const ring = (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates[0] : f.geometry.coordinates)[0];
  let x = 0, y = 0;
  ring.forEach(([px, py]) => { x += px; y += py; });
  return [x / ring.length, y / ring.length];
}

function groupColor(gid) {
  for (const g of Object.values(state.groups))
    if (g.members.includes(gid)) return g.color;
  return null;
}

function refreshRoomClasses() {
  const q = $("#search").value.trim().toLowerCase();
  document.querySelectorAll("path.room").forEach((p) => {
    const gid = p.dataset.gid;
    p.classList.toggle("selected", state.selection.has(gid));
    let fill = "";
    if (state.colorby === "group") fill = groupColor(gid) || "#e8e8e8";
    p.style.fill = state.selection.has(gid) ? "" : fill;
    let hit = false;
    if (q) {
      const nm = roomLabel(gid).toLowerCase();
      const grp = Object.values(state.groups).some((g) => g.members.includes(gid) && g.name.toLowerCase().includes(q));
      hit = nm.includes(q) || grp;
    }
    p.classList.toggle("searchhit", hit);
    const t = p.querySelector("title");
    if (t) t.textContent = roomLabel(gid);
  });
}

function refreshLabels() {
  const shows = Object.entries(state.mapShow).filter(([k, f]) => f && state.schemas[k]);
  document.querySelectorAll("text.roomlabel").forEach((t) => {
    const gid = t.dataset.gid;
    const x = t.getAttribute("x");
    t.textContent = "";
    const lines = [];
    if (state.names[gid]) lines.push({ txt: state.names[gid], cls: null });
    for (const [key, fieldKey] of shows) {
      const rec = (state.overlays[key] || {})[gid];
      let v = rec ? rec[fieldKey] : undefined;
      if (v === undefined || v === "" || v === null) continue;
      if (v === true) v = "\u2713"; else if (v === false) continue;
      v = String(v);
      if (v.length > 22) v = v.slice(0, 21) + "\u2026";
      lines.push({ txt: v, cls: "roomdata" });
    }
    lines.forEach(({ txt, cls }, i) => {
      const ts = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      ts.setAttribute("x", x);
      ts.setAttribute("dy", i === 0 ? "0" : "11");
      if (cls) ts.classList.add(cls);
      ts.textContent = txt;
      t.appendChild(ts);
    });
  });
}

function roomAt(fl, x, y) {
  for (const f of fl.geojson.features) {
    if (f.properties.type !== "room") continue;
    const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const rings of polys) {
      if (pointInRing(x, y, rings[0]) && !rings.slice(1).some((h) => pointInRing(x, y, h)))
        return fl.source + "/" + f.properties.id;
    }
  }
  return null;
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function placeMarker(key, fl, pt) {
  const mid = "m" + Date.now();
  (state.markers[key] ||= {})[mid] = {
    floor: fl.source, xy: [Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10],
    room: roomAt(fl, pt.x, pt.y), fields: {},
  };
  state.placing = null;
  document.body.classList.remove("placing");
  state.selMarker = { key, mid };
  saveOverlay(key); renderMarkers(); renderDataEditor(); renderSchemaChecks();
}
function renderMarkers() {
  document.querySelectorAll("svg[data-story]").forEach((svg) => {
    const mg = svg.querySelector("g.markerlayer");
    if (!mg) return;
    mg.innerHTML = "";
    const src = svg.dataset.source;
    const minx = +svg.dataset.minx, maxy = +svg.dataset.maxy, pad = +svg.dataset.pad;
    for (const [key, ms] of Object.entries(state.markers)) {
      if (!state.activeSchemas.has(key) && !state.mapShow[key]) continue;
      for (const [mid, m] of Object.entries(ms)) {
        if (m.floor !== src) continue;
        const cx = m.xy[0] - minx + pad, cy = maxy - m.xy[1] + pad;
        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", 5);
        c.classList.add("marker");
        if (state.selMarker && state.selMarker.mid === mid) c.classList.add("selmarker");
        c.addEventListener("click", (ev) => {
          ev.stopPropagation();
          state.selMarker = { key, mid };
          renderMarkers(); renderDataEditor();
        });
        attachMarkerDrag(c, svg, key, mid, { minx, maxy, pad });
        mg.appendChild(c);
        const fieldKey = state.mapShow[key];
        if (fieldKey) {
          let v = m.fields[fieldKey];
          if (v !== undefined && v !== "" && v !== null && v !== false) {
            if (v === true) v = "\u2713";
            v = String(v);
            if (v.length > 22) v = v.slice(0, 21) + "\u2026";
            const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
            t.classList.add("markertext");
            t.setAttribute("x", cx + 7); t.setAttribute("y", cy + 3);
            t.textContent = v;
            mg.appendChild(t);
          }
        }
      }
    }
  });
}
function attachMarkerDrag(c, svg, key, mid, frame) {
  c.addEventListener("mousedown", (ev) => {
    ev.stopPropagation(); ev.preventDefault();
    const move = (e) => {
      const p = svgPoint(svg, e);
      c.setAttribute("cx", p.x); c.setAttribute("cy", p.y);
    };
    const up = (e) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const p = svgPoint(svg, e);
      const m = state.markers[key][mid];
      m.xy = [Math.round((p.x + frame.minx - frame.pad) * 10) / 10,
              Math.round((frame.maxy - (p.y - frame.pad)) * 10) / 10];
      const fl = Object.values(state.floors).find((f) => f.source === m.floor);
      m.room = roomAt(fl, m.xy[0], m.xy[1]);
      saveOverlay(key); renderMarkers(); renderDataEditor();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

/* ---------- sidebar: rooms ---------- */
function renderSelection() {
  $("#selcount").textContent = state.selection.size ? `(${state.selection.size})` : "";
  const div = $("#sel-list");
  div.innerHTML = state.selection.size ? "" : "<p class='muted'>Click rooms to select. Ctrl-click adds; drag on empty space for rectangle select.</p>";
  for (const gid of [...state.selection].sort()) {
    const row = document.createElement("div");
    row.className = "sel-item";
    row.innerHTML = `<span class="rid">${gid}</span>`;
    const inp = document.createElement("input");
    inp.placeholder = "room name…";
    inp.value = state.names[gid] || "";
    inp.addEventListener("input", () => {
      if (inp.value) state.names[gid] = inp.value; else delete state.names[gid];
      saveNames(); refreshRoomClasses(); refreshLabels();
    });
    row.appendChild(inp);
    div.appendChild(row);
  }
}

/* ---------- sidebar: groups ---------- */
const PALETTE = ["#7db4e8","#8fd18a","#e8a37d","#c79de0","#e8d47d","#7de0d4","#e07d9d","#a5c77d"];
function renderGroups() {
  const div = $("#group-list");
  div.innerHTML = "";
  for (const [gidKey, g] of Object.entries(state.groups)) {
    const row = document.createElement("div");
    row.className = "group-row";
    row.innerHTML = `<span class="swatch" style="background:${g.color}"></span>
      <span>${g.name} <span class="muted">(${g.members.length})</span></span>`;
    const sel = document.createElement("button");
    sel.textContent = "select";
    sel.onclick = () => {
      state.selection = new Set(g.members);
      refreshRoomClasses(); renderSelection(); renderDataEditor();
    };
    const add = document.createElement("button");
    add.textContent = "+selection";
    add.onclick = () => {
      g.members = [...new Set([...g.members, ...state.selection])];
      saveGroups(); renderGroups(); refreshRoomClasses();
    };
    row.append(sel, add);
    div.appendChild(row);
  }
}
function renderGroupManage() {
  const div = $("#group-manage");
  div.innerHTML = "";
  for (const [key, g] of Object.entries(state.groups)) {
    const row = document.createElement("div");
    row.className = "group-row";
    const name = document.createElement("input");
    name.value = g.name;
    name.oninput = () => { g.name = name.value; saveGroups(); renderGroups(); };
    const color = document.createElement("input");
    color.type = "color"; color.value = g.color;
    color.oninput = () => { g.color = color.value; saveGroups(); renderGroups(); refreshRoomClasses(); };
    const minus = document.createElement("button");
    minus.textContent = "−selection";
    minus.onclick = () => {
      g.members = g.members.filter((m) => !state.selection.has(m));
      saveGroups(); renderGroups(); renderGroupManage(); refreshRoomClasses();
    };
    const del = document.createElement("button");
    del.textContent = "delete";
    del.onclick = () => {
      if (confirm(`Delete group "${g.name}"?`)) {
        delete state.groups[key]; saveGroups(); renderGroups(); renderGroupManage(); refreshRoomClasses();
      }
    };
    row.append(name, color, minus, del);
    div.appendChild(row);
  }
}
$("#btn-create-group").onclick = () => {
  const nm = $("#newgroup-name").value.trim();
  if (!nm || !state.selection.size) { alert("Name the group and select rooms first."); return; }
  const key = "g" + Date.now();
  state.groups[key] = { name: nm, color: PALETTE[Object.keys(state.groups).length % PALETTE.length], members: [...state.selection] };
  $("#newgroup-name").value = "";
  saveGroups(); renderGroups(); renderGroupManage(); refreshRoomClasses();
};

/* ---------- sidebar: overlay data ---------- */
function renderSchemaChecks() {
  const div = $("#schema-checks");
  div.innerHTML = Object.keys(state.schemas).length ? "" : "<p class='muted'>No overlay types yet — create one in Manage.</p>";
  for (const [key, sc] of Object.entries(state.schemas)) {
    const lab = document.createElement("label");
    lab.style.display = "block";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.activeSchemas.has(key);
    cb.onchange = async () => {
      if (cb.checked) {
        state.activeSchemas.add(key);
        if (!state.overlays[key]) await loadOverlay(key);
      } else state.activeSchemas.delete(key);
      renderDataEditor();
    };
    lab.append(cb, " " + sc.name + " ");
    const exp = document.createElement("a");
    exp.href = "/api/export/overlay_" + key + ".csv";
    exp.textContent = "csv";
    lab.appendChild(exp);
    const mapCb = document.createElement("input");
    mapCb.type = "checkbox";
    mapCb.checked = !!state.mapShow[key];
    mapCb.title = "show a field on the map";
    const fieldSel = document.createElement("select");
    fieldSel.className = "mapfield";
    fieldSel.innerHTML = sc.fields.map((f) =>
      `<option value="${f.key}"${state.mapShow[key] === f.key ? " selected" : ""}>${f.label}</option>`).join("");
    fieldSel.style.display = mapCb.checked ? "" : "none";
    const applyMapShow = async () => {
      if (mapCb.checked) {
        state.mapShow[key] = fieldSel.value || (sc.fields[0] && sc.fields[0].key);
        fieldSel.style.display = "";
        if (!state.overlays[key]) await loadOverlay(key);
      } else {
        delete state.mapShow[key];
        fieldSel.style.display = "none";
      }
      localStorage.setItem("mapShow", JSON.stringify(state.mapShow));
      refreshLabels();
    };
    mapCb.onchange = applyMapShow;
    fieldSel.onchange = applyMapShow;
    lab.append(" map:", mapCb, fieldSel);
    const ptBtn = document.createElement("button");
    ptBtn.textContent = state.placing === key ? "click map\u2026" : "+ point";
    ptBtn.title = "add a point entry: click this, then click a spot on the map";
    ptBtn.onclick = async () => {
      if (state.placing === key) { state.placing = null; document.body.classList.remove("placing"); }
      else {
        if (!state.overlays[key]) await loadOverlay(key);
        state.activeSchemas.add(key);
        state.placing = key;
        document.body.classList.add("placing");
      }
      renderSchemaChecks(); renderMarkers();
    };
    lab.append(" ", ptBtn);
    div.appendChild(lab);
  }
}
function dataMode() {
  return document.querySelector('#data-mode input[name=dmode]:checked').value;
}
function rowsForSchema(key) {
  if (dataMode() === "sel") return [...state.selection].sort();
  const withData = Object.entries(state.overlays[key] || {})
    .filter(([, rec]) => rec && Object.values(rec).some((v) => v !== "" && v !== null && v !== false && v !== undefined))
    .map(([gid]) => gid);
  const q = $("#data-filter").value.trim().toLowerCase();
  return withData.filter((gid) => {
    if (!q) return true;
    const rec = state.overlays[key][gid] || {};
    const hay = [gid, roomLabel(gid), ...Object.values(rec).map(String)].join(" ").toLowerCase();
    return hay.includes(q);
  }).sort();
}
function markerRowsForSchema(key) {
  if (dataMode() !== "all") return [];
  const q = $("#data-filter").value.trim().toLowerCase();
  return Object.entries(state.markers[key] || {}).filter(([mid, m]) => {
    if (!q) return true;
    const hay = [m.room ? roomLabel(m.room) : "", ...Object.values(m.fields).map(String)].join(" ").toLowerCase();
    return hay.includes(q);
  });
}
function markerEditor(div) {
  if (!state.selMarker) return;
  const { key, mid } = state.selMarker;
  const m = (state.markers[key] || {})[mid];
  const sc = state.schemas[key];
  if (!m || !sc) { state.selMarker = null; return; }
  const box = document.createElement("div");
  box.className = "schema-block";
  const story = Object.entries(state.floors).find(([, f]) => f.source === m.floor);
  box.innerHTML = `<strong>Point entry</strong> <span class="muted">${sc.name} \u00b7 Floor ${story ? story[0] : "?"} \u00b7 ` +
    `${m.room ? roomLabel(m.room) : "(no room)"} \u00b7 ${Math.round(m.xy[0])},${Math.round(m.xy[1])}</span>`;
  for (const f of sc.fields) {
    const row = document.createElement("div");
    row.className = "fieldrow";
    const labl = document.createElement("span");
    labl.textContent = f.label + ": ";
    let inp;
    if (f.type === "checkbox") {
      inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = !!m.fields[f.key];
      inp.onchange = () => { m.fields[f.key] = inp.checked; saveOverlay(key); };
    } else if (f.type === "select") {
      inp = document.createElement("select");
      inp.innerHTML = "<option></option>" + (f.options || []).map((o) => `<option>${o}</option>`).join("");
      inp.value = m.fields[f.key] || "";
      inp.onchange = () => { m.fields[f.key] = inp.value; saveOverlay(key); };
    } else {
      inp = document.createElement("input");
      inp.type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
      inp.value = m.fields[f.key] ?? "";
      inp.oninput = () => { m.fields[f.key] = inp.type === "number" && inp.value !== "" ? +inp.value : inp.value; saveOverlay(key); };
    }
    inp.style.flex = "1";
    row.append(labl, inp);
    box.appendChild(row);
  }
  const del = document.createElement("button");
  del.textContent = "delete point";
  del.onclick = () => {
    if (confirm("Delete this point entry?")) {
      delete state.markers[key][mid];
      state.selMarker = null;
      saveOverlay(key); renderMarkers(); renderDataEditor();
    }
  };
  const desel = document.createElement("button");
  desel.textContent = "close";
  desel.onclick = () => { state.selMarker = null; renderMarkers(); renderDataEditor(); };
  box.append(del, " ", desel);
  div.appendChild(box);
}

function renderDataEditor() {
  const div = $("#data-editor");
  div.innerHTML = "";
  markerEditor(div);
  if (dataMode() === "sel" && !state.selection.size) {
    div.innerHTML = "<p class='muted'>Select rooms to view/enter data, or switch to \u201call rooms\u201d.</p>"; return;
  }
  for (const key of state.activeSchemas) {
    const sc = state.schemas[key];
    if (!sc) continue;
    const h = document.createElement("h4");
    h.textContent = sc.name;
    div.appendChild(h);
    const rows = rowsForSchema(key);
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = dataMode() === "all" ? "no rooms with data (or none match filter)" : "";
      div.appendChild(p);
    }
    const table = document.createElement("table");
    table.innerHTML = "<tr><th>room</th>" + sc.fields.map((f) => `<th>${f.label}</th>`).join("") + "</tr>";
    for (const gid of rows) {
      const tr = document.createElement("tr");
      const td0 = document.createElement("td");
      td0.className = "roomcell";
      td0.textContent = roomLabel(gid);
      td0.title = gid + " \u2014 click to select on map";
      td0.onclick = () => {
        state.selection = new Set([gid]);
        refreshRoomClasses(); renderSelection();
      };
      tr.appendChild(td0);
      for (const f of sc.fields) {
        const td = document.createElement("td");
        const rec = (state.overlays[key][gid] ||= {});
        let inp;
        if (f.type === "checkbox") {
          inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = !!rec[f.key];
          inp.onchange = () => { rec[f.key] = inp.checked; saveOverlay(key); };
        } else if (f.type === "select") {
          inp = document.createElement("select");
          inp.innerHTML = "<option></option>" + (f.options || []).map((o) => `<option>${o}</option>`).join("");
          inp.value = rec[f.key] || "";
          inp.onchange = () => { rec[f.key] = inp.value; saveOverlay(key); };
        } else {
          inp = document.createElement("input");
          inp.type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
          inp.value = rec[f.key] ?? "";
          inp.oninput = () => { rec[f.key] = inp.type === "number" && inp.value !== "" ? +inp.value : inp.value; saveOverlay(key); };
        }
        td.appendChild(inp);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    for (const [mid, m] of markerRowsForSchema(key)) {
      const tr = document.createElement("tr");
      const td0 = document.createElement("td");
      td0.className = "roomcell";
      td0.textContent = "\u25cf " + (m.room ? roomLabel(m.room) : "(no room)");
      td0.title = "point entry \u2014 click to open";
      td0.onclick = () => { state.selMarker = { key, mid }; renderMarkers(); renderDataEditor(); };
      tr.appendChild(td0);
      for (const f of sc.fields) {
        const td = document.createElement("td");
        const v = m.fields[f.key];
        td.textContent = v === true ? "\u2713" : (v ?? "");
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    div.appendChild(table);
  }
}

/* ---------- sidebar: schema management ---------- */
const FIELD_TYPES = ["text", "number", "checkbox", "date", "select"];
function renderSchemaEditor() {
  const div = $("#schema-editor");
  div.innerHTML = "";
  for (const [key, sc] of Object.entries(state.schemas)) {
    const block = document.createElement("div");
    block.className = "schema-block";
    const name = document.createElement("input");
    name.value = sc.name;
    name.oninput = () => { sc.name = name.value; saveSchemas(); renderSchemaChecks(); };
    const del = document.createElement("button");
    del.textContent = "delete type";
    del.onclick = () => {
      if (confirm(`Delete overlay type "${sc.name}"? (data file kept on disk)`)) {
        delete state.schemas[key]; state.activeSchemas.delete(key);
        saveSchemas(); renderSchemaEditor(); renderSchemaChecks(); renderDataEditor();
      }
    };
    block.append(name, del);
    for (const f of sc.fields) {
      const row = document.createElement("div");
      row.className = "fieldrow";
      const fl = document.createElement("input");
      fl.value = f.label;
      fl.oninput = () => { f.label = fl.value; f.key = f.key || fl.value.toLowerCase().replace(/\W+/g, "_"); saveSchemas(); };
      const ft = document.createElement("select");
      ft.innerHTML = FIELD_TYPES.map((t) => `<option${t === f.type ? " selected" : ""}>${t}</option>`).join("");
      ft.onchange = () => { f.type = ft.value; saveSchemas(); };
      const opts = document.createElement("input");
      opts.placeholder = "options,comma,separated";
      opts.value = (f.options || []).join(",");
      opts.oninput = () => { f.options = opts.value.split(",").map((s) => s.trim()).filter(Boolean); saveSchemas(); };
      const rm = document.createElement("button");
      rm.textContent = "×";
      rm.onclick = () => { sc.fields = sc.fields.filter((x) => x !== f); saveSchemas(); renderSchemaEditor(); };
      row.append(fl, ft, opts, rm);
      block.appendChild(row);
    }
    const addf = document.createElement("button");
    addf.textContent = "add field";
    addf.onclick = () => { sc.fields.push({ key: "field" + (sc.fields.length + 1), label: "field" + (sc.fields.length + 1), type: "text" }); saveSchemas(); renderSchemaEditor(); };
    block.appendChild(addf);
    div.appendChild(block);
  }
}
$("#btn-new-schema").onclick = () => {
  const nm = prompt("Overlay type name (e.g. Inventory, Work needed):");
  if (!nm) return;
  const key = nm.toLowerCase().replace(/\W+/g, "_");
  state.schemas[key] = { name: nm, fields: [{ key: "note", label: "note", type: "text" }] };
  state.overlays[key] = {};
  saveSchemas(); renderSchemaEditor(); renderSchemaChecks();
};

/* ---------- tabs / topbar ---------- */
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tabpane").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $("#tab-" + b.dataset.tab).classList.add("active");
  }));
document.querySelectorAll("#floor-checks input").forEach((c) => c.addEventListener("change", renderMaps));
$("#colorby").addEventListener("change", (e) => { state.colorby = e.target.value; refreshRoomClasses(); });
$("#search").addEventListener("input", refreshRoomClasses);

document.querySelectorAll('#data-mode input[name=dmode]').forEach((r) =>
  r.addEventListener("change", renderDataEditor));
$("#data-filter").addEventListener("input", debounce(renderDataEditor, 250));

/* ---------- init ---------- */
(async function init() {
  state.floors = await api.get("floors");
  state.names = await api.get("data/names");
  state.groups = await api.get("data/groups");
  state.schemas = await api.get("data/schemas");
  for (const key of Object.keys(state.mapShow)) {
    if (!state.schemas[key]) { delete state.mapShow[key]; continue; }
    await loadOverlay(key);
  }
  renderMaps(); renderSelection(); renderGroups(); renderGroupManage();
  renderSchemaChecks(); renderSchemaEditor(); renderDataEditor(); refreshLabels(); renderMarkers();
})();
