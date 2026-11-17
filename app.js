// ShotSwap Timeline Review & Version Player
// Independent Web GUI

(function () {
  const data = window.SHOTSWAP_CUT;
  if (!data || !data.shots || data.shots.length === 0) {
    console.warn("Cut manifest data not yet built. Run setup_production.py or click 'Sync & Rescan' in the header.");
  }

  // Update dynamic header brand and title if available
  try {
    const badge = document.getElementById("appBrandBadge");
    if (badge && data && data.project) badge.textContent = data.project.toUpperCase();
    const tag = document.getElementById("appTimelineTag");
    if (tag && data && data.shots) tag.textContent = `${data.shots.length} Shots | Conformed Cut (Handles Trimmed)`;
  } catch (e) { }

  if (!data || !data.shots || data.shots.length === 0) {
    return;
  }

  const FPS = data.fps || 24;
  const START_FRAME = data.start_frame || 86208;
  const shots = data.shots;

  // Compute total timeline duration
  const minRecordFrame = shots[0].record_start;
  const maxRecordFrame = shots[shots.length - 1].record_end;
  const totalTimelineFrames = maxRecordFrame - minRecordFrame;

  // Application State
  let currentTimelineFrame = minRecordFrame;
  let currentShotIndex = 0;
  let isPlaying = false;
  let playbackSpeed = 1.0;
  let loopShot = false;
  let notes = [];

  // DOM Elements
  const videoA = document.getElementById("videoA");
  const videoB = document.getElementById("videoB");
  const videoBase = document.getElementById("videoBase");
  const videoC = document.getElementById("videoC");
  const abWipeLine = document.getElementById("abWipeLine");
  const abWipeTagLeft = document.getElementById("abWipeTagLeft");
  const abWipeTagRight = document.getElementById("abWipeTagRight");
  const videoStage = document.getElementById("videoStage");
  let activeVideo = videoA;
  let preloadVideo = videoB;

  // Base Layer (A/B) & Version (A/C) Comparison State
  let abMode = "A"; // "A" | "B" | "SPLIT" | "C" | "SPLIT_AC"
  let wipePercent = 50;
  let baseAudioEnabled = true;
  let baseStartFrame = 86208;
  let hasBaseMovie = false;

  const btnPlay = document.getElementById("btnPlay");
  const overlayShotCode = document.getElementById("overlayShotCode");
  const overlayVersion = document.getElementById("overlayVersion");
  const overlayTimecode = document.getElementById("overlayTimecode");
  const overlayFrameInfo = document.getElementById("overlayFrameInfo");
  const shotStrip = document.getElementById("shotStrip");
  const playheadLine = document.getElementById("playheadLine");

  const inspectorShotCode = document.getElementById("inspectorShotCode");
  const inspectorDuration = document.getElementById("inspectorDuration");
  const inspectorTCIn = document.getElementById("inspectorTCIn");
  const inspectorTCOut = document.getElementById("inspectorTCOut");
  const inspectorHandles = document.getElementById("inspectorHandles");
  const versionSelect = document.getElementById("versionSelect");
  const versionCountBadge = document.getElementById("versionCountBadge");

  const noteTextarea = document.getElementById("noteTextarea");
  const noteColorSelect = document.getElementById("noteColorSelect");
  const noteScopeSelect = document.getElementById("noteScopeSelect");
  const btnAddNote = document.getElementById("btnAddNote");
  const notesList = document.getElementById("notesList");
  const noteCountLabel = document.getElementById("noteCountLabel");

  const btnExportCutEDL = document.getElementById("btnExportCutEDL");
  const btnExportCutCSV = document.getElementById("btnExportCutCSV");
  const chkSwappedOnly = document.getElementById("chkSwappedOnly");
  const btnExportCSV = document.getElementById("btnExportCSV");
  const btnExportEDL = document.getElementById("btnExportEDL");
  const btnExportJSON = document.getElementById("btnExportJSON");
  const btnImportJSON = document.getElementById("btnImportJSON");
  const fileInputJSON = document.getElementById("fileInputJSON");
  const speedSelect = document.getElementById("speedSelect");

  // Record baseline version index and baseline source_in from the conformed Resolve cut before applying user overrides
  shots.forEach((s) => {
    s.baseline_version_index = s.active_version_index || 0;
    s.baseline_source_in = s.source_in || 0;
  });

  // Load Saved Notes from LocalStorage
  try {
    const savedNotes = localStorage.getItem("shotswap_review_notes");
    if (savedNotes) {
      notes = JSON.parse(savedNotes);
    }
  } catch (e) {
    console.warn("Could not load notes from localStorage", e);
  }

  // Load Saved Version Overrides if any
  try {
    const savedVersions = localStorage.getItem("shotswap_version_choices");
    if (savedVersions) {
      const choices = JSON.parse(savedVersions);
      shots.forEach((s) => {
        if (choices[s.shot_code] !== undefined) {
          s.active_version_index = choices[s.shot_code];
        }
      });
    }
  } catch (e) {
    console.warn("Could not load version choices", e);
  }

  // Load Saved Source-In Slip Overrides if any
  try {
    const savedSlips = localStorage.getItem("shotswap_slip_choices");
    if (savedSlips) {
      const slips = JSON.parse(savedSlips);
      shots.forEach((s) => {
        if (slips[s.shot_code] !== undefined) {
          s.source_in = Math.max(0, parseInt(slips[s.shot_code], 10) || 0);
          s.source_out = s.source_in + s.duration;
        }
      });
    }
  } catch (e) {
    console.warn("Could not load slip choices", e);
  }

  // Load Saved Compare (C) Version Overrides if any (default is index 1 = 2nd most recent version)
  try {
    const savedC = localStorage.getItem("shotswap_c_version_choices");
    if (savedC) {
      const cMap = JSON.parse(savedC);
      shots.forEach((s) => {
        if (cMap[s.shot_code] !== undefined) {
          s.c_version_index = parseInt(cMap[s.shot_code], 10);
        }
      });
    }
  } catch (e) {
    console.warn("Could not load C version choices", e);
  }

  // Timecode Conversion Utilities
  function framesToTC(frameNum, fps = 24) {
    const totalFrames = Math.max(0, Math.floor(frameNum));
    const h = Math.floor(totalFrames / (fps * 3600));
    const m = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
    const s = Math.floor((totalFrames % (fps * 60)) / fps);
    const f = totalFrames % fps;
    return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
  }

  function framesToDurationTC(durFrames, fps = 24) {
    return framesToTC(durFrames, fps);
  }

  function pad(n) {
    return n.toString().padStart(2, "0");
  }

  // Resolve media URL from relative path
  function getMediaUrl(relPath) {
    if (!relPath) return "";
    // If opened via local web server at project root, path is /relPath
    // If opened from /review/, path is ../relPath
    if (window.location.protocol === "file:") {
      return `../${relPath}`;
    }
    return `/${relPath}`;
  }

  // Get active version object (A) for a shot
  function getActiveVersion(shot) {
    if (!shot.versions || shot.versions.length === 0) {
      return null;
    }
    const idx = shot.active_version_index || 0;
    return shot.versions[Math.min(idx, shot.versions.length - 1)];
  }

  // Get Compare (C) version index & object for a shot (defaults to index 1 = 2nd most recent version)
  function getCVersionIndex(shot) {
    if (!shot || !shot.versions || shot.versions.length === 0) return 0;
    if (shot.c_version_index !== undefined && shot.c_version_index >= 0 && shot.c_version_index < shot.versions.length) {
      return shot.c_version_index;
    }
    return shot.versions.length > 1 ? 1 : 0;
  }

  function getCVersion(shot) {
    if (!shot || !shot.versions || shot.versions.length === 0) return null;
    return shot.versions[getCVersionIndex(shot)];
  }

  // Render Timeline Ruler & Strip (Zoomable, True Cut-Point Proportional)
  let timelineZoom = 1.0;
  const timelineZoomInner = document.getElementById("timelineZoomInner");
  const timelineRuler = document.getElementById("timelineRuler");
  const timelineZoomSlider = document.getElementById("timelineZoomSlider");
  const zoomLevelLabel = document.getElementById("zoomLevelLabel");
  const btnZoomIn = document.getElementById("btnZoomIn");
  const btnZoomOut = document.getElementById("btnZoomOut");
  const btnZoomFit = document.getElementById("btnZoomFit");

  function renderTimelineRuler() {
    if (!timelineRuler) return;
    timelineRuler.innerHTML = "";

    const minFrame = shots.length ? shots[0].record_start : minRecordFrame;
    const maxFrame = shots.length ? shots[shots.length - 1].record_end : maxRecordFrame;
    const spanFrames = Math.max(1, maxFrame - minFrame);

    // Choose tick interval in frames based on zoom level
    let stepSec = 60;
    if (timelineZoom >= 16) stepSec = 2;
    else if (timelineZoom >= 8) stepSec = 5;
    else if (timelineZoom >= 4) stepSec = 10;
    else if (timelineZoom >= 2) stepSec = 30;
    const stepFrames = stepSec * FPS;

    const firstTick = Math.ceil(minFrame / stepFrames) * stepFrames;
    for (let f = firstTick; f <= maxFrame; f += stepFrames) {
      const pct = ((f - minFrame) / spanFrames) * 100;
      const tick = document.createElement("div");
      tick.className = "ruler-tick";
      tick.style.left = `${pct}%`;
      tick.textContent = framesToTC(f, FPS);
      timelineRuler.appendChild(tick);
    }

    // Also draw note/marker pins on the ruler
    notes.forEach((n) => {
      if (n.frame_number >= minFrame && n.frame_number <= maxFrame) {
        const pct = ((n.frame_number - minFrame) / spanFrames) * 100;
        const pin = document.createElement("div");
        pin.className = "ruler-marker-pin";
        pin.style.left = `${pct}%`;
        pin.style.backgroundColor = getMarkerHexColor(n.color);
        pin.title = `${n.shot_code} (${n.record_in}): ${n.text}`;
        timelineRuler.appendChild(pin);
      }
    });
  }

  function renderTimelineStrip() {
    shotStrip.innerHTML = "";
    const minFrame = shots.length ? shots[0].record_start : minRecordFrame;
    const maxFrame = shots.length ? shots[shots.length - 1].record_end : maxRecordFrame;
    const spanFrames = Math.max(1, maxFrame - minFrame);

    if (timelineZoomInner) {
      timelineZoomInner.style.width = `${timelineZoom * 100}%`;
    }
    renderTimelineRuler();

    shots.forEach((shot, idx) => {
      const block = document.createElement("div");
      const isSwapped = (shot.active_version_index || 0) !== (shot.baseline_version_index || 0);
      const baseSrcIn = shot.baseline_source_in !== undefined ? shot.baseline_source_in : (shot.source_in || 0);
      const slipDelta = (shot.source_in || 0) - baseSrcIn;
      const isModified = isSwapped || slipDelta !== 0;
      block.className = `shot-block ${idx % 2 === 0 ? "even" : ""} ${isModified ? "swapped" : ""} ${idx === currentShotIndex ? "active" : ""}`;
      block.id = `shot-block-${idx}`;

      // True proportional cut-point placement and width
      const leftPercent = ((shot.record_start - minFrame) / spanFrames) * 100;
      const widthPercent = (shot.duration / spanFrames) * 100;
      block.style.left = `${leftPercent}%`;
      block.style.width = `${widthPercent}%`;

      const activeVer = getActiveVersion(shot);
      const verLabel = activeVer ? (activeVer.version || activeVer.kind) : "";
      const slipBadge = slipDelta !== 0 ? ` [${slipDelta > 0 ? "+" : ""}${slipDelta}f]` : "";

      block.innerHTML = `
        <div class="shot-block-top">
          <span class="shot-block-label">${shot.shot_code}</span>
          <span class="shot-block-ver">${verLabel}${slipBadge}</span>
        </div>
        <div class="shot-block-sub">${shot.timecode_in} (${shot.duration}f)</div>
      `;

      block.title = `${shot.shot_code} — Shot #${shot.index} (${shot.duration}f | ${shot.active_track || "V4"})\nCut In: ${shot.timecode_in}  →  Cut Out: ${shot.timecode_out}\nSource In: ${shot.source_in}f → ${shot.source_out}f${slipDelta !== 0 ? ` (Slipped ${slipDelta > 0 ? "+" : ""}${slipDelta}f)` : ""}\nActive: ${activeVer ? activeVer.base_name : "None"}${isSwapped ? "\n★ Version Swapped from Baseline" : ""}`;

      block.addEventListener("click", (e) => {
        e.stopPropagation();
        // Seek to exact clicked frame within the shot block
        const rect = block.getBoundingClientRect();
        const ratioInShot = Math.max(0, Math.min(0.999, (e.clientX - rect.left) / Math.max(1, rect.width)));
        const offsetFrames = Math.floor(ratioInShot * shot.duration);
        seekToShot(idx, offsetFrames);
      });

      shotStrip.appendChild(block);
    });
  }

  // Update Inspector Panel with Current Shot Info + Scrolling Thumbnail Browser
  const versionThumbList = document.getElementById("versionThumbList");
  const inpSourceIn = document.getElementById("inpSourceIn");
  const inspectorClipLength = document.getElementById("inspectorClipLength");

  function updateClipLengthLabel() {
    if (!inspectorClipLength) return;
    const shot = shots[currentShotIndex];
    if (!shot) return;
    if (activeVideo && activeVideo.duration && isFinite(activeVideo.duration)) {
      const totalClipFrames = Math.round(activeVideo.duration * FPS);
      const tailAvail = Math.max(0, totalClipFrames - (shot.source_in + shot.duration));
      inspectorClipLength.textContent = `Clip: ${totalClipFrames}f (Tail: +${tailAvail}f)`;
    } else {
      inspectorClipLength.textContent = `Baseline In: ${shot.baseline_source_in !== undefined ? shot.baseline_source_in : 10}f`;
    }
  }
  videoA.addEventListener("loadedmetadata", updateClipLengthLabel);
  videoB.addEventListener("loadedmetadata", updateClipLengthLabel);

  let thumbObserver = null;
  if ("IntersectionObserver" in window && versionThumbList) {
    thumbObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const vid = entry.target.querySelector("video[data-src]");
          if (vid) {
            vid.src = vid.getAttribute("data-src");
            vid.removeAttribute("data-src");
          }
          thumbObserver.unobserve(entry.target);
        }
      });
    }, { root: versionThumbList, rootMargin: "80px" });
  }

  function selectShotVersion(shot, newIdx) {
    if (!shot || isNaN(newIdx)) return;
    shot.active_version_index = newIdx;
    saveVersionChoices();
    renderTimelineStrip();
    updateInspector();
    updateOverlays();
    loadShotMedia(activeVideo, shot, currentTimelineFrame - shot.record_start);
  }

  function setShotSourceIn(shot, newSourceIn) {
    if (!shot) return;
    const clamped = Math.max(0, Math.round(newSourceIn));
    shot.source_in = clamped;
    shot.source_out = clamped + shot.duration;
    saveSlipChoices();
    renderTimelineStrip();
    updateInspector();
    updateOverlays();
    const offset = currentTimelineFrame - shot.record_start;
    loadShotMedia(activeVideo, shot, offset);
    loadCVideoMedia(shot, offset);
  }

  function selectShotCVersion(shot, cIdx) {
    if (!shot || isNaN(cIdx)) return;
    shot.c_version_index = cIdx;
    saveCVersionChoices();
    updateInspector();
    updateOverlays();
    loadCVideoMedia(shot, currentTimelineFrame - shot.record_start);
  }

  function saveCVersionChoices() {
    try {
      const cMap = {};
      shots.forEach((s) => {
        if (s.c_version_index !== undefined) {
          cMap[s.shot_code] = s.c_version_index;
        }
      });
      localStorage.setItem("shotswap_c_version_choices", JSON.stringify(cMap));
    } catch (e) {
      console.warn("Error saving C version choices", e);
    }
  }

  const inspectorCVersionLabel = document.getElementById("inspectorCVersionLabel");
  const btnResetCToSecond = document.getElementById("btnResetCToSecond");
  if (btnResetCToSecond) {
    btnResetCToSecond.addEventListener("click", () => {
      const shot = shots[currentShotIndex];
      if (!shot) return;
      delete shot.c_version_index;
      saveCVersionChoices();
      updateInspector();
      updateOverlays();
      loadCVideoMedia(shot, currentTimelineFrame - shot.record_start);
    });
  }

  function saveSlipChoices() {
    try {
      const slips = {};
      shots.forEach((s) => {
        const baseIn = s.baseline_source_in !== undefined ? s.baseline_source_in : 10;
        if (s.source_in !== baseIn) {
          slips[s.shot_code] = s.source_in;
        }
      });
      localStorage.setItem("shotswap_slip_choices", JSON.stringify(slips));
    } catch (e) {
      console.warn("Error saving slip choices", e);
    }
  }

  function updateInspector() {
    const shot = shots[currentShotIndex];
    if (!shot) return;

    const baseSrcIn = shot.baseline_source_in !== undefined ? shot.baseline_source_in : (shot.source_in || 0);
    const slipDelta = (shot.source_in || 0) - baseSrcIn;
    const slipStr = slipDelta !== 0 ? ` (Slip ${slipDelta > 0 ? "+" : ""}${slipDelta}f)` : "";

    inspectorShotCode.textContent = `${shot.shot_code} (Shot #${shot.index} of ${shots.length})`;
    inspectorDuration.textContent = `${shot.duration} frames (${(shot.duration / FPS).toFixed(2)}s)`;
    inspectorTCIn.textContent = shot.timecode_in;
    inspectorTCOut.textContent = shot.timecode_out;
    inspectorHandles.textContent = `In: ${shot.source_in}f → Out: ${shot.source_out}f${slipStr}`;
    if (inpSourceIn && document.activeElement !== inpSourceIn) {
      inpSourceIn.value = shot.source_in;
    }
    updateClipLengthLabel();

    versionCountBadge.textContent = `${shot.versions ? shot.versions.length : 0} versions`;

    const cIdx = getCVersionIndex(shot);
    const cVer = getCVersion(shot);
    if (inspectorCVersionLabel) {
      inspectorCVersionLabel.textContent = cVer ? `${cVer.base_name} (${cVer.kind})` : "None";
    }

    // Populate Version Dropdown & Scrolling Thumbnail List
    versionSelect.innerHTML = "";
    if (versionThumbList) versionThumbList.innerHTML = "";

    if (shot.versions && shot.versions.length > 0) {
      const cutInSec = Math.max(0, shot.source_in / FPS).toFixed(2);
      const baseIdx = shot.baseline_version_index || 0;

      shot.versions.forEach((ver, vIdx) => {
        const isCurrent = vIdx === (shot.active_version_index || 0);
        const isCompareC = vIdx === cIdx;
        const isBaseline = vIdx === baseIdx;
        const formatBadge = ver.mp4_path ? "[MP4]" : "[MOV+Proxy]";

        // 1. Dropdown option
        const opt = document.createElement("option");
        opt.value = vIdx;
        opt.textContent = `${formatBadge} ${ver.base_name}  (${ver.kind}) — ${ver.date_formatted}${isCurrent ? " ★ [A]" : ""}${isCompareC ? " [C]" : ""}`;
        if (isCurrent) opt.selected = true;
        versionSelect.appendChild(opt);

        // 2. Scrolling Thumbnail Card
        if (versionThumbList) {
          let mediaPath = ver.mp4_path;
          if (!mediaPath || mediaPath.toLowerCase().endsWith(".mov")) {
            mediaPath = `review/.web_proxies/${ver.base_name}.mp4`;
          }
          const thumbUrl = `${getMediaUrl(mediaPath)}#t=${cutInSec}`;

          const card = document.createElement("div");
          card.className = `version-thumb-card ${isCurrent ? "active" : ""}`;
          card.innerHTML = `
            <div class="version-thumb-preview">
              <video preload="metadata" muted playsinline data-src="${thumbUrl}"></video>
              <span class="version-thumb-badge">${ver.version || ver.kind}</span>
            </div>
            <div class="version-thumb-info">
              <div class="version-thumb-name" title="${ver.base_name}">${ver.base_name}</div>
              <div class="version-thumb-date">${ver.date_formatted} • ${ver.size_mb} MB</div>
              <div class="version-thumb-tags">
                <span class="tag-pill tag-kind">${ver.kind}</span>
                ${isCurrent ? `<span class="tag-pill tag-active">ACTIVE (A)</span>` : ""}
                ${isCompareC ? `<span class="tag-pill tag-compare-c">COMPARE (C)</span>` : ""}
                ${isBaseline ? `<span class="tag-pill tag-baseline">BASELINE</span>` : ""}
                <button class="btn-set-c" title="Set this version as Compare (C) for A/C comparison">Set as C</button>
              </div>
            </div>
          `;
          if (thumbObserver) {
            thumbObserver.observe(card);
          } else {
            const v = card.querySelector("video");
            if (v && vIdx < 6) v.src = thumbUrl;
          }

          // Hover scrubbing on thumbnail video preview
          const vidEl = card.querySelector("video");
          if (vidEl) {
            card.addEventListener("mousemove", (ev) => {
              const rect = card.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
              const scrubFrame = shot.source_in + ratio * shot.duration;
              if (vidEl.readyState >= 1) {
                vidEl.currentTime = scrubFrame / FPS;
              }
            });
            card.addEventListener("mouseleave", () => {
              if (vidEl.readyState >= 1) {
                vidEl.currentTime = shot.source_in / FPS;
              }
            });
          }

          const btnSetC = card.querySelector(".btn-set-c");
          if (btnSetC) {
            btnSetC.addEventListener("click", (ev) => {
              ev.stopPropagation();
              selectShotCVersion(shot, vIdx);
            });
          }

          card.addEventListener("click", () => {
            selectShotVersion(shot, vIdx);
          });

          versionThumbList.appendChild(card);
        }
      });
    } else {
      const opt = document.createElement("option");
      opt.textContent = "No versions found on disk";
      versionSelect.appendChild(opt);
    }
  }

  // Handle Version Swapping & Shot Source-In Slip Controls
  versionSelect.addEventListener("change", (e) => {
    const newIdx = parseInt(e.target.value, 10);
    const shot = shots[currentShotIndex];
    selectShotVersion(shot, newIdx);
  });

  if (inpSourceIn) {
    inpSourceIn.addEventListener("change", (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val)) {
        setShotSourceIn(shots[currentShotIndex], val);
      }
    });
  }
  const btnSlipBack10 = document.getElementById("btnSlipBack10");
  const btnSlipBack1 = document.getElementById("btnSlipBack1");
  const btnSlipFwd1 = document.getElementById("btnSlipFwd1");
  const btnSlipFwd10 = document.getElementById("btnSlipFwd10");
  const btnSlipZero = document.getElementById("btnSlipZero");
  const btnSlipTen = document.getElementById("btnSlipTen");
  const btnSlipMarkCurrent = document.getElementById("btnSlipMarkCurrent");
  const btnSlipReset = document.getElementById("btnSlipReset");

  if (btnSlipBack10) btnSlipBack10.addEventListener("click", () => setShotSourceIn(shots[currentShotIndex], (shots[currentShotIndex].source_in || 0) - 10));
  if (btnSlipBack1) btnSlipBack1.addEventListener("click", () => setShotSourceIn(shots[currentShotIndex], (shots[currentShotIndex].source_in || 0) - 1));
  if (btnSlipFwd1) btnSlipFwd1.addEventListener("click", () => setShotSourceIn(shots[currentShotIndex], (shots[currentShotIndex].source_in || 0) + 1));
  if (btnSlipFwd10) btnSlipFwd10.addEventListener("click", () => setShotSourceIn(shots[currentShotIndex], (shots[currentShotIndex].source_in || 0) + 10));
  if (btnSlipZero) btnSlipZero.addEventListener("click", () => setShotSourceIn(shots[currentShotIndex], 0));
  if (btnSlipTen) btnSlipTen.addEventListener("click", () => setShotSourceIn(shots[currentShotIndex], 10));
  if (btnSlipMarkCurrent) {
    btnSlipMarkCurrent.addEventListener("click", () => {
      const curVidFrame = Math.round((activeVideo.currentTime || 0) * FPS);
      setShotSourceIn(shots[currentShotIndex], curVidFrame);
      seekToShot(currentShotIndex, 0);
    });
  }
  if (btnSlipReset) {
    btnSlipReset.addEventListener("click", () => {
      const shot = shots[currentShotIndex];
      if (shot) setShotSourceIn(shot, shot.baseline_source_in !== undefined ? shot.baseline_source_in : 10);
    });
  }

  function saveVersionChoices() {
    try {
      const choices = {};
      shots.forEach((s) => {
        choices[s.shot_code] = s.active_version_index || 0;
      });
      localStorage.setItem("shotswap_version_choices", JSON.stringify(choices));
    } catch (e) {
      console.warn("Error saving version choices", e);
    }
  }

  // Load Shot Media into a Video Element with Handles Trimmed
  function loadVersionIntoVideoEl(videoEl, ver, shot, frameOffsetInShot = 0) {
    if (!videoEl || !ver || !shot) return;

    // Prefer native mp4, otherwise use generated web proxy in review/.web_proxies/
    let mediaPath = ver.mp4_path;
    if (!mediaPath || mediaPath.toLowerCase().endsWith(".mov")) {
      mediaPath = `review/.web_proxies/${ver.base_name}.mp4`;
    }
    const url = getMediaUrl(mediaPath);

    // Only update src if different
    const currentSrc = videoEl.getAttribute("data-loaded-path");
    if (currentSrc !== mediaPath) {
      videoEl.src = url;
      videoEl.setAttribute("data-loaded-path", mediaPath);
      videoEl.playbackRate = playbackSpeed;
    }

    // Set time respecting handles (source_in offset)
    const targetSourceFrame = shot.source_in + frameOffsetInShot;
    const targetTimeSec = Math.max(0, targetSourceFrame / FPS);

    videoEl.currentTime = targetTimeSec;
  }

  function loadShotMedia(videoEl, shot, frameOffsetInShot = 0) {
    const ver = getActiveVersion(shot);
    loadVersionIntoVideoEl(videoEl, ver, shot, frameOffsetInShot);
  }

  function loadCVideoMedia(shot, frameOffsetInShot = 0, forceLoad = false) {
    if (!videoC || !shot) return;
    if (!forceLoad && abMode !== "C" && abMode !== "SPLIT_AC") return;
    const cVer = getCVersion(shot);
    loadVersionIntoVideoEl(videoC, cVer, shot, frameOffsetInShot);
  }

  function syncCVideo(forceSeek = false) {
    if (!videoC || (abMode !== "C" && abMode !== "SPLIT_AC")) return;
    const shot = shots[currentShotIndex];
    if (!shot) return;
    const offset = Math.max(0, currentTimelineFrame - shot.record_start);
    const targetSec = Math.max(0, (shot.source_in + offset) / FPS);
    if (forceSeek || Math.abs(videoC.currentTime - targetSec) > 0.1) {
      videoC.currentTime = targetSec;
    }
  }

  // Sync Base Layer Mixdown Movie to currentTimelineFrame
  function syncBaseVideo(forceSeek = false) {
    if (!videoBase || !hasBaseMovie) return;
    const targetBaseSec = Math.max(0, (currentTimelineFrame - baseStartFrame) / FPS);
    if (forceSeek || Math.abs(videoBase.currentTime - targetBaseSec) > 0.12) {
      videoBase.currentTime = targetBaseSec;
    }
  }

  function syncAudioRouting() {
    if (videoBase && hasBaseMovie && baseAudioEnabled) {
      videoBase.muted = false;
      videoA.muted = true;
      videoB.muted = true;
    } else {
      if (videoBase) videoBase.muted = true;
      videoA.muted = false;
      videoB.muted = false;
    }
    if (videoC) videoC.muted = true;
  }

  function applyABMode() {
    const btnABCompare = document.getElementById("btnABCompare");
    const btnACCompare = document.getElementById("btnACCompare");
    if ((abMode === "B" || abMode === "SPLIT") && !hasBaseMovie) {
      abMode = "A";
    }
    // Clear clip paths & z-index on all video layers first
    videoA.style.clipPath = "none";
    videoB.style.clipPath = "none";
    videoA.style.zIndex = "";
    videoB.style.zIndex = "";
    if (videoBase) {
      videoBase.className = "video-hidden";
      videoBase.style.zIndex = "";
    }
    if (videoC) {
      videoC.className = "video-hidden";
      videoC.style.zIndex = "";
    }

    // Reset button labels first
    if (btnABCompare) {
      btnABCompare.textContent = "🌓 A/B: VFX (A)";
      btnABCompare.classList.remove("btn-primary");
    }
    if (btnACCompare) {
      btnACCompare.textContent = "🔀 A/C: VFX (A)";
      btnACCompare.classList.remove("btn-primary");
    }

    const shot = shots[currentShotIndex];
    const verA = shot ? getActiveVersion(shot) : null;
    const verC = shot ? getCVersion(shot) : null;

    if (abMode === "A") {
      if (abWipeLine) abWipeLine.style.display = "none";
    } else if (abMode === "B") {
      if (btnABCompare) {
        btnABCompare.textContent = "🌓 A/B: BASE (B)";
        btnABCompare.classList.add("btn-primary");
      }
      if (videoBase) {
        videoBase.className = "video-base-visible";
        videoBase.style.zIndex = "5";
      }
      if (abWipeLine) abWipeLine.style.display = "none";
      syncBaseVideo(true);
    } else if (abMode === "SPLIT") {
      if (btnABCompare) {
        btnABCompare.textContent = "🌓 A/B: SPLIT (A|B)";
        btnABCompare.classList.add("btn-primary");
      }
      if (videoBase) {
        videoBase.className = "video-base-visible";
        videoBase.style.zIndex = "2";
      }
      activeVideo.style.zIndex = "3";
      activeVideo.style.clipPath = `inset(0 ${100 - wipePercent}% 0 0)`;
      if (abWipeTagLeft) abWipeTagLeft.textContent = `A: ${verA ? (verA.version || verA.kind) : "VFX"}`;
      if (abWipeTagRight) abWipeTagRight.textContent = "B: BASE";
      if (abWipeLine) {
        abWipeLine.style.display = "block";
        abWipeLine.style.left = `${wipePercent}%`;
      }
      syncBaseVideo(true);
    } else if (abMode === "C") {
      if (btnACCompare) {
        btnACCompare.textContent = "🔀 A/C: VER (C)";
        btnACCompare.classList.add("btn-primary");
      }
      if (videoC) {
        videoC.className = "video-base-visible";
        videoC.style.zIndex = "5";
      }
      if (abWipeLine) abWipeLine.style.display = "none";
      syncCVideo(true);
    } else if (abMode === "SPLIT_AC") {
      if (btnACCompare) {
        btnACCompare.textContent = "🔀 A/C: SPLIT (A|C)";
        btnACCompare.classList.add("btn-primary");
      }
      if (videoC) {
        videoC.className = "video-base-visible";
        videoC.style.zIndex = "2";
      }
      activeVideo.style.zIndex = "3";
      activeVideo.style.clipPath = `inset(0 ${100 - wipePercent}% 0 0)`;
      if (abWipeTagLeft) abWipeTagLeft.textContent = `A: ${verA ? (verA.version || verA.kind) : "Active"}`;
      if (abWipeTagRight) abWipeTagRight.textContent = `C: ${verC ? (verC.version || verC.kind) : "Compare"}`;
      if (abWipeLine) {
        abWipeLine.style.display = "block";
        abWipeLine.style.left = `${wipePercent}%`;
      }
      syncCVideo(true);
    }
    updateOverlays();
  }

  // Update HUD Overlays
  function updateOverlays() {
    const shot = shots[currentShotIndex];
    if (!shot) return;

    overlayShotCode.textContent = shot.shot_code;
    const ver = getActiveVersion(shot);
    const cVer = getCVersion(shot);
    const verText = ver ? `${ver.base_name} (${ver.kind})` : "No Version";
    const cVerText = cVer ? `${cVer.base_name} (${cVer.kind})` : "No Version";

    if (abMode === "B") {
      overlayVersion.textContent = `[BASE LAYER B] vs ${verText}`;
    } else if (abMode === "SPLIT") {
      overlayVersion.textContent = `[A|B SPLIT] A: ${ver ? ver.base_name : "VFX"} | B: Base Mixdown`;
    } else if (abMode === "C") {
      overlayVersion.textContent = `[COMPARE C] ${cVerText} (vs A: ${ver ? (ver.version || ver.kind) : ""})`;
    } else if (abMode === "SPLIT_AC") {
      overlayVersion.textContent = `[A|C SPLIT] A: ${ver ? ver.base_name : "Active"} | C: ${cVer ? cVer.base_name : "Compare"}`;
    } else {
      overlayVersion.textContent = verText;
    }

    overlayTimecode.textContent = framesToTC(currentTimelineFrame, FPS);

    const frameInShot = currentTimelineFrame - shot.record_start;
    overlayFrameInfo.textContent = `Frame: ${currentTimelineFrame} | Shot: ${frameInShot + 1}/${shot.duration} (${shot.timecode_in} - ${shot.timecode_out})`;

    // Update playhead position on timeline track
    const minFrame = shots.length ? shots[0].record_start : minRecordFrame;
    const maxFrame = shots.length ? shots[shots.length - 1].record_end : maxRecordFrame;
    const pct = ((currentTimelineFrame - minFrame) / Math.max(1, maxFrame - minFrame)) * 100;
    playheadLine.style.left = `${Math.min(100, Math.max(0, pct))}%`;
    ensurePlayheadVisible();

    // Highlight active shot block
    document.querySelectorAll(".shot-block").forEach((el, idx) => {
      el.classList.toggle("active", idx === currentShotIndex);
    });
  }

  // Seek to specific shot and frame offset
  function seekToShot(shotIdx, frameOffset = 0) {
    if (shotIdx < 0 || shotIdx >= shots.length) return;

    currentShotIndex = shotIdx;
    const shot = shots[currentShotIndex];
    currentTimelineFrame = shot.record_start + Math.min(frameOffset, shot.duration - 1);

    updateInspector();
    updateOverlays();
    loadShotMedia(activeVideo, shot, frameOffset);
    loadCVideoMedia(shot, frameOffset);
    syncBaseVideo(true);

    // Preload next shot in background player
    if (shotIdx + 1 < shots.length) {
      loadShotMedia(preloadVideo, shots[shotIdx + 1], 0);
    }
  }

  // Seek by delta frames
  function stepFrames(delta) {
    pausePlayback();
    const targetFrame = currentTimelineFrame + delta;
    if (targetFrame < minRecordFrame || targetFrame >= maxRecordFrame) return;

    // Find which shot owns targetFrame
    let foundIdx = currentShotIndex;
    for (let i = 0; i < shots.length; i++) {
      if (targetFrame >= shots[i].record_start && targetFrame < shots[i].record_end) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx !== currentShotIndex) {
      const offset = targetFrame - shots[foundIdx].record_start;
      seekToShot(foundIdx, offset);
    } else {
      currentTimelineFrame = targetFrame;
      const shot = shots[currentShotIndex];
      const offset = currentTimelineFrame - shot.record_start;
      const targetSec = (shot.source_in + offset) / FPS;
      activeVideo.currentTime = targetSec;
      syncCVideo(true);
      syncBaseVideo(true);
      updateOverlays();
    }
  }

  // Playback Control
  function togglePlay() {
    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  }

  function startPlayback() {
    isPlaying = true;
    btnPlay.textContent = "⏸ Pause";
    btnPlay.classList.add("btn-primary");
    syncAudioRouting();
    activeVideo.playbackRate = playbackSpeed;
    activeVideo.play().catch((err) => {
      console.warn("Playback error:", err);
    });
    if (videoC) {
      syncCVideo(true);
      videoC.playbackRate = playbackSpeed;
      videoC.play().catch(() => { });
    }
    if (videoBase && hasBaseMovie) {
      syncBaseVideo(true);
      videoBase.playbackRate = playbackSpeed;
      videoBase.play().catch(() => { });
    }
  }

  function pausePlayback() {
    isPlaying = false;
    btnPlay.textContent = "▶ Play";
    btnPlay.classList.remove("btn-primary");
    activeVideo.pause();
    preloadVideo.pause();
    if (videoC) videoC.pause();
    if (videoBase && hasBaseMovie) {
      videoBase.pause();
    }
  }

  // High-precision Playback Loop on both ping-pong video elements
  function onActiveVideoTimeUpdate(e) {
    if (!isPlaying || e.target !== activeVideo) return;

    const shot = shots[currentShotIndex];
    if (!shot) return;

    const curSec = activeVideo.currentTime;
    const curSourceFrame = Math.floor(curSec * FPS);
    const frameInShot = curSourceFrame - shot.source_in;

    // Check if reached end of current shot cut
    if (frameInShot >= shot.duration) {
      if (loopShot) {
        // Loop current shot
        seekToShot(currentShotIndex, 0);
        activeVideo.play();
        if (videoC) videoC.play().catch(() => { });
        if (videoBase && hasBaseMovie) videoBase.play().catch(() => { });
        return;
      }

      // Cut to next shot!
      if (currentShotIndex + 1 < shots.length) {
        currentShotIndex++;
        const nextShot = shots[currentShotIndex];
        currentTimelineFrame = nextShot.record_start;

        // Ping-pong video switch
        const temp = activeVideo;
        activeVideo = preloadVideo;
        preloadVideo = temp;

        activeVideo.classList.remove("video-hidden");
        activeVideo.classList.add("video-active");
        preloadVideo.classList.remove("video-active");
        preloadVideo.classList.add("video-hidden");

        loadCVideoMedia(nextShot, 0);
        if (videoC && isPlaying) {
          videoC.playbackRate = playbackSpeed;
          videoC.play().catch(() => { });
        }

        if (abMode === "SPLIT" || abMode === "SPLIT_AC") {
          preloadVideo.style.clipPath = "none";
          preloadVideo.style.zIndex = "";
          activeVideo.style.zIndex = "3";
          activeVideo.style.clipPath = `inset(0 ${100 - wipePercent}% 0 0)`;
          const verA = getActiveVersion(nextShot);
          const verC = getCVersion(nextShot);
          if (abWipeTagLeft) abWipeTagLeft.textContent = `A: ${verA ? (verA.version || verA.kind) : "Active"}`;
          if (abMode === "SPLIT_AC" && abWipeTagRight) {
            abWipeTagRight.textContent = `C: ${verC ? (verC.version || verC.kind) : "Compare"}`;
          }
        }

        activeVideo.playbackRate = playbackSpeed;
        activeVideo.play().catch(console.warn);
        syncBaseVideo(false);

        updateInspector();
        updateOverlays();

        // Preload shot after next
        if (currentShotIndex + 1 < shots.length) {
          loadShotMedia(preloadVideo, shots[currentShotIndex + 1], 0);
        }
      } else {
        // End of timeline
        pausePlayback();
        seekToShot(0, 0);
      }
    } else {
      currentTimelineFrame = shot.record_start + Math.max(0, frameInShot);
      syncCVideo(false);
      syncBaseVideo(false);
      updateOverlays();
    }
  }
  videoA.addEventListener("timeupdate", onActiveVideoTimeUpdate);
  videoB.addEventListener("timeupdate", onActiveVideoTimeUpdate);

  // Timeline Click / Drag Scrubbing & Zoom Controls
  let isDraggingTimeline = false;
  const trackContainer = document.getElementById("timelineTrack");

  function setTimelineZoom(newZoom, anchorClientX = null) {
    const clamped = Math.max(1.0, Math.min(25.0, Math.round(newZoom * 10) / 10));
    if (clamped === timelineZoom) return;

    const containerWidth = trackContainer.clientWidth || 1;
    const oldScrollWidth = trackContainer.scrollWidth || containerWidth;

    // Determine anchor ratio (either mouse cursor position or current playhead)
    let anchorRatio = (currentTimelineFrame - minRecordFrame) / Math.max(1, totalTimelineFrames);
    let viewportOffset = containerWidth / 2;

    if (anchorClientX !== null) {
      const cRect = trackContainer.getBoundingClientRect();
      viewportOffset = anchorClientX - cRect.left;
      anchorRatio = (trackContainer.scrollLeft + viewportOffset) / oldScrollWidth;
    } else {
      const playheadPx = anchorRatio * oldScrollWidth;
      if (playheadPx >= trackContainer.scrollLeft && playheadPx <= trackContainer.scrollLeft + containerWidth) {
        viewportOffset = playheadPx - trackContainer.scrollLeft;
      }
    }

    timelineZoom = clamped;
    if (timelineZoomInner) {
      timelineZoomInner.style.width = `${timelineZoom * 100}%`;
    }
    if (timelineZoomSlider) timelineZoomSlider.value = timelineZoom;
    if (zoomLevelLabel) zoomLevelLabel.textContent = `${timelineZoom.toFixed(1)}x`;

    renderTimelineRuler();

    // Restore scroll position so the anchored frame stays right under cursor/playhead
    const newScrollWidth = containerWidth * timelineZoom;
    trackContainer.scrollLeft = Math.max(0, anchorRatio * newScrollWidth - viewportOffset);
  }

  function ensurePlayheadVisible() {
    if (!trackContainer || timelineZoom <= 1.0) return;
    const pct = (currentTimelineFrame - minRecordFrame) / Math.max(1, totalTimelineFrames);
    const totalW = trackContainer.scrollWidth;
    const viewW = trackContainer.clientWidth;
    const playheadX = pct * totalW;
    const margin = Math.min(80, viewW * 0.15);

    if (playheadX < trackContainer.scrollLeft + margin) {
      trackContainer.scrollLeft = Math.max(0, playheadX - margin);
    } else if (playheadX > trackContainer.scrollLeft + viewW - margin) {
      trackContainer.scrollLeft = playheadX - viewW + margin;
    }
  }

  if (timelineZoomSlider) {
    timelineZoomSlider.addEventListener("input", (e) => {
      setTimelineZoom(parseFloat(e.target.value));
    });
  }
  if (btnZoomIn) {
    btnZoomIn.addEventListener("click", () => setTimelineZoom(timelineZoom * 1.4));
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener("click", () => setTimelineZoom(timelineZoom / 1.4));
  }
  if (btnZoomFit) {
    btnZoomFit.addEventListener("click", () => setTimelineZoom(1.0));
  }

  // Mouse wheel over timeline zooms in/out anchored at cursor
  trackContainer.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      setTimelineZoom(timelineZoom * factor, e.clientX);
    }
  }, { passive: false });

  function handleTimelineScrub(e) {
    const innerEl = timelineZoomInner || shotStrip;
    const rect = innerEl.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / Math.max(1, rect.width)));
    const minFrame = shots.length ? shots[0].record_start : minRecordFrame;
    const maxFrame = shots.length ? shots[shots.length - 1].record_end : maxRecordFrame;
    const targetFrame = minFrame + Math.floor(ratio * (maxFrame - minFrame));

    // Find shot (or nearest shot if clicked in a small gap)
    for (let i = 0; i < shots.length; i++) {
      if (targetFrame >= shots[i].record_start && targetFrame < shots[i].record_end) {
        seekToShot(i, targetFrame - shots[i].record_start);
        break;
      }
    }
  }

  trackContainer.addEventListener("mousedown", (e) => {
    isDraggingTimeline = true;
    handleTimelineScrub(e);
  });

  window.addEventListener("mousemove", (e) => {
    if (isDraggingTimeline) {
      handleTimelineScrub(e);
    }
  });

  window.addEventListener("mouseup", () => {
    isDraggingTimeline = false;
  });

  // Notes & Feedback Management
  function renderNotes() {
    notesList.innerHTML = "";
    noteCountLabel.textContent = `${notes.length} notes`;

    // Sort notes by timeline frame
    notes.sort((a, b) => a.frame_number - b.frame_number);
    renderTimelineRuler();

    if (notes.length === 0) {
      notesList.innerHTML = `<div style="color:var(--text-dim); text-align:center; padding:16px;">No notes yet. Add notes while watching the cut!</div>`;
      return;
    }

    notes.forEach((note, idx) => {
      const item = document.createElement("div");
      item.className = "note-item";
      item.style.borderLeftColor = getMarkerHexColor(note.color);

      item.innerHTML = `
        <div class="note-header">
          <span class="note-tc">${note.record_in}</span>
          <span class="note-shot">${note.shot_code} (${note.color})</span>
          <button class="note-delete-btn" title="Delete note" data-idx="${idx}">✕</button>
        </div>
        <div class="note-body">${escapeHtml(note.text)}</div>
      `;

      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("note-delete-btn")) return;
        jumpToFrame(note.frame_number);
      });

      const delBtn = item.querySelector(".note-delete-btn");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        notes.splice(idx, 1);
        saveNotes();
        renderNotes();
      });

      notesList.appendChild(item);
    });
  }

  function getMarkerHexColor(color) {
    const map = {
      Blue: "#3b82f6",
      Cyan: "#06b6d4",
      Green: "#10b981",
      Yellow: "#eab308",
      Red: "#ef4444",
      Pink: "#ec4899",
      Purple: "#a855f7",
      Fuchsia: "#d946ef",
      Rose: "#f43f5e",
      Lavender: "#c084fc",
      Sky: "#38bdf8",
      Mint: "#34d399",
      Lemon: "#facc15",
      Sand: "#d97706",
      Cocoa: "#78350f",
      White: "#ffffff"
    };
    return map[color] || "#3b82f6";
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function saveNotes() {
    try {
      localStorage.setItem("shotswap_review_notes", JSON.stringify(notes));
    } catch (e) {
      console.warn("Error saving notes", e);
    }
  }

  function jumpToFrame(targetFrame) {
    for (let i = 0; i < shots.length; i++) {
      if (targetFrame >= shots[i].record_start && targetFrame < shots[i].record_end) {
        seekToShot(i, targetFrame - shots[i].record_start);
        break;
      }
    }
  }

  // Add Note Button
  btnAddNote.addEventListener("click", () => {
    const text = noteTextarea.value.trim();
    if (!text) {
      alert("Please type a note first.");
      return;
    }

    const shot = shots[currentShotIndex];
    const ver = getActiveVersion(shot);
    const color = noteColorSelect.value;
    const scope = noteScopeSelect.value;

    let recIn = framesToTC(currentTimelineFrame, FPS);
    let recOut = recIn;
    let dur = 1;
    let frameNum = currentTimelineFrame;

    if (scope === "shot") {
      recIn = shot.timecode_in;
      recOut = shot.timecode_out;
      dur = shot.duration;
      frameNum = shot.record_start;
    }

    const newNote = {
      id: "note_" + Date.now(),
      shot_code: shot.shot_code,
      version_name: ver ? ver.base_name : shot.active_clip,
      record_in: recIn,
      record_out: recOut,
      source_in: framesToTC(shot.source_in, FPS),
      source_out: framesToTC(shot.source_out, FPS),
      duration: framesToDurationTC(dur, FPS),
      duration_frames: dur,
      frame_number: frameNum,
      color: color,
      marker_name: `${shot.shot_code}_${ver ? ver.version : "review"}`,
      text: text,
      created_at: new Date().toISOString()
    };

    notes.push(newNote);
    saveNotes();
    renderNotes();
    noteTextarea.value = "";
  });

  // Helper: get original disk path and filename for a version (never the web proxy path)
  function getOriginalVersionFile(shot, ver) {
    if (!ver) {
      return { filename: shot.active_clip || shot.shot_code, relPath: "" };
    }
    // If mov_path exists, prefer that as the master deliverable or native mp4 if not in .web_proxies
    let origRel = ver.mov_path;
    if (!origRel && ver.mp4_path && !ver.mp4_path.includes(".web_proxies")) {
      origRel = ver.mp4_path;
    }
    if (origRel) {
      const parts = origRel.split("/");
      const rootP = (inpMediaSource && inpMediaSource.value.trim()) || "";
      const fullP = rootP ? `${rootP.replace(/[\\/]+$/, "")}\\${origRel.replace(/\//g, "\\")}` : origRel;
      return { filename: parts[parts.length - 1], relPath: fullP };
    }
    return { filename: `${ver.base_name}.mov`, relPath: "" };
  }

  // Export Assembled Proxy Cut Movie with Burn-Ins (.mp4)
  const btnExportBurninMovie = document.getElementById("btnExportBurninMovie");
  if (btnExportBurninMovie) {
    btnExportBurninMovie.addEventListener("click", async () => {
      if (window.location.protocol === "file:") {
        alert("Please open the player via launch_player.bat (http://localhost:8080/review/) to render a Burn-In Proxy Movie.");
        return;
      }
      try {
        btnExportBurninMovie.disabled = true;
        const tlName = (selResolveTimeline && selResolveTimeline.value) || data.timeline_name || "SHOTSWAP_CUT";
        const defaultName = `${tlName}_BURNIN.mp4`;

        const dlgResp = await fetch("/api/dialog/save-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            initial_dir: (inpMediaSource && inpMediaSource.value.trim()) || "",
            default_name: defaultName,
            title: "Save Burn-In Proxy Movie As (.mp4)"
          })
        });
        const dlg = await dlgResp.json();
        if (!dlg.ok || !dlg.path) {
          btnExportBurninMovie.disabled = false;
          return;
        }

        const mediaRoot = (inpMediaSource && inpMediaSource.value.trim()) || "";
        const shotSpecs = shots.map((s) => {
          const ver = getActiveVersion(s);
          let relMedia = ver ? ver.mp4_path : "";
          if (!relMedia || relMedia.toLowerCase().endsWith(".mov")) {
            relMedia = ver ? `review/.web_proxies/${ver.base_name}.mp4` : "";
          }
          const fullMediaPath = relMedia ? `${mediaRoot.replace(/[\\/]+$/, "")}\\${relMedia.replace(/\//g, "\\")}` : "";
          const baseSrcIn = s.baseline_source_in !== undefined ? s.baseline_source_in : (s.source_in || 0);
          const slipDelta = (s.source_in || 0) - baseSrcIn;
          return {
            shot_code: s.shot_code,
            version_name: ver ? ver.base_name : (s.active_clip || s.shot_code),
            media_path: fullMediaPath,
            source_in: s.source_in || 0,
            duration: s.duration || 24,
            record_start: s.record_start || 86400,
            slip_delta: slipDelta
          };
        });

        if (serverStatusText) {
          serverStatusText.textContent = `Starting GPU Burn-In Render -> ${dlg.name}...`;
        }
        const expResp = await fetch("/api/export-movie", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fps: FPS,
            timeline_name: tlName,
            output_path: dlg.path,
            base_movie_path: selBaseMovie ? selBaseMovie.value : "",
            base_start_frame: baseStartFrame,
            shots: shotSpecs
          })
        });
        const expRes = await expResp.json();
        if (!expRes.ok) {
          alert(expRes.error || "Could not start Burn-In Movie export.");
          btnExportBurninMovie.disabled = false;
        } else {
          showCompletionToast(`🎬 Rendering Burn-In Movie: ${dlg.name} (watch progress in top bar)...`);
          startPollingServerStatus();
        }
      } catch (err) {
        alert("Failed to start Burn-In Movie export: " + err);
        btnExportBurninMovie.disabled = false;
      }
    });
  }

  // Helper: check if a shot's selected version or source_in differs from the baseline Resolve cut
  function isShotDifferentFromCut(s) {
    const isSwappedIdx = (s.active_version_index || 0) !== (s.baseline_version_index || 0);
    const baseIn = s.baseline_source_in !== undefined ? s.baseline_source_in : (s.source_in || 0);
    const isSlipped = (s.source_in || 0) !== baseIn;
    const ver = getActiveVersion(s);
    const resolveStem = (s.active_clip || "")
      .replace(/\.[^/.]+$/, "")
      .replace(/[\._\s]*\[\d+\-\d+\].*$/, "")
      .replace(/\.mov Render$/i, "")
      .trim()
      .toLowerCase();
    const selectedStem = (ver ? ver.base_name : "").trim().toLowerCase();
    const isDifferentFromResolveClip = Boolean(resolveStem && selectedStem && resolveStem !== selectedStem);
    return isSwappedIdx || isSlipped || isDifferentFromResolveClip;
  }

  function runCutEDLExport(diffOnly) {
    const targetShots = diffOnly ? shots.filter(isShotDifferentFromCut) : shots;
    if (targetShots.length === 0) {
      alert("No shots differ from the current Resolve baseline cut yet! Swap a version or nudge a shot's Source In first, or use 'Export Everything EDL'.");
      return;
    }

    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let edl = `TITLE: SHOTSWAP_CUT_${now}${diffOnly ? "_WHATS_NEW" : "_FULL"}\nFCM: NON-DROP FRAME\n\n`;

    targetShots.forEach((shot, idx) => {
      const eventNum = (idx + 1).toString().padStart(3, "0");
      const ver = getActiveVersion(shot);
      const orig = getOriginalVersionFile(shot, ver);
      const baseVer = shot.versions && shot.versions[shot.baseline_version_index || 0];
      const isDiff = isShotDifferentFromCut(shot);
      const baseIn = shot.baseline_source_in !== undefined ? shot.baseline_source_in : (shot.source_in || 0);
      const slipDelta = (shot.source_in || 0) - baseIn;

      const srcInTC = framesToTC(shot.source_in, FPS);
      const srcOutTC = framesToTC(shot.source_in + shot.duration, FPS);
      const recInTC = shot.timecode_in;
      const recOutTC = shot.timecode_out;

      edl += `${eventNum}  AX       V     C        ${srcInTC} ${srcOutTC} ${recInTC} ${recOutTC}\n`;
      edl += `* FROM CLIP NAME: ${orig.filename}\n`;
      if (orig.relPath) {
        edl += `* SOURCE FILE: ${orig.relPath}\n`;
      }
      if (isDiff) {
        const fromLabel = shot.active_clip || (baseVer ? baseVer.base_name : "Baseline");
        edl += `* VERSION SWAPPED FROM: ${fromLabel} TO: ${ver ? ver.base_name : orig.filename}\n`;
      }
      if (slipDelta !== 0) {
        edl += `* SOURCE IN SLIPPED: ${baseIn}f -> ${shot.source_in}f (${slipDelta > 0 ? "+" : ""}${slipDelta}f)\n`;
      }
      edl += `\n`;
    });

    downloadFile(edl, `ShotSwap_Cut_${now}${diffOnly ? "_Whats_New" : "_Everything"}.edl`, "text/plain;charset=utf-8;");
  }

  function runCutCSVExport(diffOnly) {
    const targetShots = diffOnly ? shots.filter(isShotDifferentFromCut) : shots;
    if (targetShots.length === 0) {
      alert("No shots differ from the current Resolve baseline cut yet! Swap a version or nudge a shot's Source In first, or use 'Everything CSV'.");
      return;
    }

    let csv = "Event,Shot Code,Sequence,Selected Version,Clip Filename,Source Path,Different From Cut,Slip Delta Frames,Source In Frame,Resolve Baseline Clip,Record In,Record Out,Source In TC,Source Out TC,Duration Frames\n";

    targetShots.forEach((shot, idx) => {
      const ver = getActiveVersion(shot);
      const orig = getOriginalVersionFile(shot, ver);
      const isDiff = isShotDifferentFromCut(shot);
      const baseIn = shot.baseline_source_in !== undefined ? shot.baseline_source_in : (shot.source_in || 0);
      const slipDelta = (shot.source_in || 0) - baseIn;

      const srcInTC = framesToTC(shot.source_in, FPS);
      const srcOutTC = framesToTC(shot.source_in + shot.duration, FPS);
      const selectedName = ver ? ver.base_name : shot.active_clip;
      const baselineName = shot.active_clip || "";

      csv += `${idx + 1},${shot.shot_code},${shot.sequence},"${selectedName}","${orig.filename}","${orig.relPath}",${isDiff ? "YES" : "NO"},${slipDelta},${shot.source_in},"${baselineName}",${shot.timecode_in},${shot.timecode_out},${srcInTC},${srcOutTC},${shot.duration}\n`;
    });

    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    downloadFile(csv, `ShotSwap_Cut_${now}${diffOnly ? "_Whats_New" : "_Everything"}.csv`, "text/csv;charset=utf-8;");
  }

  const btnExportWhatsNewEDL = document.getElementById("btnExportWhatsNewEDL");
  const btnExportWhatsNewCSV = document.getElementById("btnExportWhatsNewCSV");
  const btnPushUpdatesToResolve = document.getElementById("btnPushUpdatesToResolve");
  const btnExportWhatsNewDRT = document.getElementById("btnExportWhatsNewDRT");

  function collectWhatsNewUpdates() {
    let diffShots = shots.filter(isShotModifiedFromBaseline);
    if (diffShots.length === 0) {
      // Offer to auto-select all shots that have a newer version on disk than the Resolve cut
      const newerCount = shots.filter((s) => (s.baseline_version_index || 0) > 0).length;
      if (newerCount > 0) {
        const autoSwitch = confirm(
          `0 shots are currently modified in the player, but ${newerCount} shot(s) have a newer version on disk than the Resolve cut.\n\nSwitch those ${newerCount} shot(s) to their latest version now and proceed?`
        );
        if (autoSwitch) {
          shots.forEach((s) => {
            if ((s.baseline_version_index || 0) > 0 && s.versions && s.versions.length > 0) {
              s.active_version_index = 0;
            }
          });
          saveVersionChoices();
          renderTimelineStrip();
          updateInspector();
          updateOverlays();
          diffShots = shots.filter(isShotModifiedFromBaseline);
        }
      }
    }
    if (diffShots.length === 0) {
      alert("0 shots differ from the current Resolve timeline cut! Select a different version on at least one shot (or click '⚡ Set All to Latest Version') first.");
      return null;
    }

    const baseRoot = inpMediaSource && inpMediaSource.value.trim() ? inpMediaSource.value.trim().replace(/[\\/]+$/, "") : "";
    return diffShots.map((s) => {
      const vIdx = s.active_version_index || 0;
      const ver = s.versions && s.versions[vIdx] ? s.versions[vIdx] : null;
      const srcRel = ver ? (ver.mov_path || ver.mp4_path || "") : "";
      const srcFull = srcRel ? `${baseRoot}\\${srcRel.replace(/\//g, "\\")}` : "";
      const clipFile = srcRel ? srcRel.split("/").pop() : (ver ? `${ver.base_name}.mov` : s.active_clip);
      return {
        index: s.index,
        shot_code: s.shot_code,
        record_start: s.record_start,
        record_end: s.record_end,
        duration: s.duration,
        source_in: s.source_in !== undefined ? s.source_in : 10,
        source_out: (s.source_in !== undefined ? s.source_in : 10) + s.duration,
        version_name: clipFile,
        source_path: srcFull
      };
    });
  }

  if (btnPushUpdatesToResolve) {
    btnPushUpdatesToResolve.addEventListener("click", async () => {
      const updates = collectWhatsNewUpdates();
      if (!updates) return;
      if (!confirm(`Place ${updates.length} updated shot(s) onto a new top video track in the open DaVinci Resolve timeline?`)) {
        return;
      }
      try {
        btnPushUpdatesToResolve.disabled = true;
        btnPushUpdatesToResolve.textContent = `⏳ Placing ${updates.length} Shots in Resolve...`;
        const resp = await fetch("/api/resolve/sync-timeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "update_timeline", updates: updates })
        });
        const res = await resp.json();
        if (!res.ok) {
          alert(res.error || "Failed to start Resolve timeline update.");
          btnPushUpdatesToResolve.disabled = false;
          btnPushUpdatesToResolve.textContent = '🚀 Update Open Resolve Timeline — Place "What\'s New" on New Track';
          return;
        }
        startPollingServerStatus();
      } catch (err) {
        alert("Could not reach local server: " + err);
        btnPushUpdatesToResolve.disabled = false;
        btnPushUpdatesToResolve.textContent = '🚀 Update Open Resolve Timeline — Place "What\'s New" on New Track';
      }
    });
  }

  if (btnExportWhatsNewDRT) {
    btnExportWhatsNewDRT.addEventListener("click", async () => {
      const updates = collectWhatsNewUpdates();
      if (!updates) return;
      const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const defName = `SHOTSWAP_CUT_${now}_WHATS_NEW.drt`;
      try {
        btnExportWhatsNewDRT.disabled = true;
        const dlgResp = await fetch("/api/dialog/save-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            initial_dir: (inpMediaSource && inpMediaSource.value.trim()) || "",
            default_name: defName,
            title: "Save 'What's New' DaVinci Resolve Timeline (.drt) As",
            kind: "drt"
          })
        });
        const dlg = await dlgResp.json();
        if (!dlg.ok || !dlg.path) {
          btnExportWhatsNewDRT.disabled = false;
          return;
        }
        btnExportWhatsNewDRT.textContent = `⏳ Exporting DRT (${updates.length} Shots)...`;
        const resp = await fetch("/api/resolve/sync-timeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "export_drt",
            output_path: dlg.path,
            updates: updates
          })
        });
        const res = await resp.json();
        if (!res.ok) {
          alert(res.error || "Failed to start DRT export.");
          btnExportWhatsNewDRT.disabled = false;
          btnExportWhatsNewDRT.textContent = '📦 Export "What\'s New" DRT — Diff Only (.drt)';
          return;
        }
        startPollingServerStatus();
      } catch (err) {
        alert("Could not reach local server: " + err);
        btnExportWhatsNewDRT.disabled = false;
        btnExportWhatsNewDRT.textContent = '📦 Export "What\'s New" DRT — Diff Only (.drt)';
      }
    });
  }

  if (btnExportWhatsNewEDL) {
    btnExportWhatsNewEDL.addEventListener("click", () => runCutEDLExport(true));
  }
  if (btnExportCutEDL) {
    btnExportCutEDL.addEventListener("click", () => runCutEDLExport(false));
  }
  if (btnExportWhatsNewCSV) {
    btnExportWhatsNewCSV.addEventListener("click", () => runCutCSVExport(true));
  }
  if (btnExportCutCSV) {
    btnExportCutCSV.addEventListener("click", () => runCutCSVExport(false));
  }

  // Export Resolve Importable CSV
  btnExportCSV.addEventListener("click", () => {
    if (notes.length === 0) {
      alert("No notes to export. Add some notes first (or use 'Export Cut Versions CSV' above to export shot version selections)!");
      return;
    }

    // DaVinci Resolve Marker CSV Header
    let csv = "EDL Event,Record In,Record Out,Source In,Source Out,Duration,Marker Name,Description,Color,Selected Version\n";

    notes.forEach((n, idx) => {
      const cleanText = `"${n.text.replace(/"/g, '""')}"`;
      const cleanName = `"${(n.marker_name || n.shot_code).replace(/"/g, '""')}"`;
      const cleanVer = `"${(n.version_name || "").replace(/"/g, '""')}"`;
      csv += `${idx + 1},${n.record_in},${n.record_out},${n.source_in},${n.source_out},${n.duration},${cleanName},${cleanText},${n.color},${cleanVer}\n`;
    });

    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    downloadFile(csv, `ShotSwap_Markers_${now}.csv`, "text/csv;charset=utf-8;");
  });

  // Export CMX 3600 Marker EDL
  btnExportEDL.addEventListener("click", () => {
    if (notes.length === 0) {
      alert("No notes to export. Add some notes first (or use 'Export Cut EDL' above to export shot version selections)!");
      return;
    }

    let edl = `TITLE: SHOTSWAP_REVIEW_MARKERS\nFCM: NON-DROP FRAME\n\n`;

    notes.forEach((n, idx) => {
      const eventNum = pad(idx + 1).padStart(3, "0");
      edl += `${eventNum}  AX       V     C        ${n.record_in} ${n.record_out} ${n.record_in} ${n.record_out}\n`;
      edl += `* FROM CLIP NAME: ${n.version_name || n.shot_code}\n`;
      edl += `* LOC: ${n.record_in} ${n.color.toUpperCase()} [${n.version_name || n.shot_code}] ${n.text}\n\n`;
    });

    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    downloadFile(edl, `ShotSwap_Markers_${now}.edl`, "text/plain;charset=utf-8;");
  });

  // Export / Import Full Review State JSON
  btnExportJSON.addEventListener("click", () => {
    const choices = {};
    const slips = {};
    shots.forEach((s) => {
      choices[s.shot_code] = s.active_version_index || 0;
      if (s.source_in !== (s.baseline_source_in !== undefined ? s.baseline_source_in : 10)) {
        slips[s.shot_code] = s.source_in;
      }
    });

    const snapshot = {
      project: (data && data.project) || "SHOTSWAP",
      exported_at: new Date().toISOString(),
      version_choices: choices,
      slip_choices: slips,
      notes: notes
    };

    const str = JSON.stringify(snapshot, null, 2);
    downloadFile(str, `ShotSwap_Review_Snapshot_${Date.now()}.json`, "application/json");
  });

  btnImportJSON.addEventListener("click", () => {
    fileInputJSON.click();
  });

  fileInputJSON.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const snap = JSON.parse(evt.target.result);
        if (snap.version_choices) {
          shots.forEach((s) => {
            if (snap.version_choices[s.shot_code] !== undefined) {
              s.active_version_index = snap.version_choices[s.shot_code];
            }
          });
          saveVersionChoices();
        }
        if (snap.slip_choices) {
          shots.forEach((s) => {
            if (snap.slip_choices[s.shot_code] !== undefined) {
              s.source_in = Math.max(0, parseInt(snap.slip_choices[s.shot_code], 10) || 0);
              s.source_out = s.source_in + s.duration;
            }
          });
          saveSlipChoices();
        }
        if (snap.notes && Array.isArray(snap.notes)) {
          notes = snap.notes;
          saveNotes();
          renderNotes();
        }
        renderTimelineStrip();
        updateInspector();
        updateOverlays();
        alert("Review snapshot successfully loaded!");
      } catch (err) {
        alert("Failed to parse JSON snapshot file: " + err);
      }
    };
    reader.readAsText(file);
  });

  function downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 100);
  }

  // Keyboard Navigation Controls
  window.addEventListener("keydown", (e) => {
    // If typing in input or textarea, don't trigger hotkeys
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") {
      return;
    }

    switch (e.key) {
      case " ":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        stepFrames(e.shiftKey ? -10 : -1);
        break;
      case "ArrowRight":
        e.preventDefault();
        stepFrames(e.shiftKey ? 10 : 1);
        break;
      case "[":
        e.preventDefault();
        setShotSourceIn(shots[currentShotIndex], (shots[currentShotIndex].source_in || 0) - (e.altKey || e.shiftKey ? 10 : 1));
        break;
      case "]":
        e.preventDefault();
        setShotSourceIn(shots[currentShotIndex], (shots[currentShotIndex].source_in || 0) + (e.altKey || e.shiftKey ? 10 : 1));
        break;
      case "PageUp":
      case "q":
      case "Q":
        e.preventDefault();
        if (currentShotIndex > 0) seekToShot(currentShotIndex - 1, 0);
        break;
      case "PageDown":
      case "w":
      case "W":
        e.preventDefault();
        if (currentShotIndex + 1 < shots.length) seekToShot(currentShotIndex + 1, 0);
        break;
      case "l":
      case "L":
        loopShot = !loopShot;
        document.getElementById("btnLoop").classList.toggle("btn-primary", loopShot);
        break;
      case "f":
      case "F":
        toggleFullscreen();
        break;
      case "b":
      case "B":
        e.preventDefault();
        cycleABMode();
        break;
      case "c":
      case "C":
        e.preventDefault();
        cycleACMode();
        break;
      case "m":
      case "M":
        e.preventDefault();
        toggleBaseAudio();
        break;
      case "+":
      case "=":
        e.preventDefault();
        setTimelineZoom(timelineZoom * 1.35);
        break;
      case "-":
      case "_":
        e.preventDefault();
        setTimelineZoom(timelineZoom / 1.35);
        break;
      case "0":
        e.preventDefault();
        setTimelineZoom(1.0);
        break;
    }
  });

  // UI Event Listeners
  btnPlay.addEventListener("click", togglePlay);
  document.getElementById("btnStepBack10").addEventListener("click", () => stepFrames(-10));
  document.getElementById("btnStepBack1").addEventListener("click", () => stepFrames(-1));
  document.getElementById("btnStepFwd1").addEventListener("click", () => stepFrames(1));
  document.getElementById("btnStepFwd10").addEventListener("click", () => stepFrames(10));
  document.getElementById("btnPrevShot").addEventListener("click", () => {
    if (currentShotIndex > 0) seekToShot(currentShotIndex - 1, 0);
  });
  document.getElementById("btnNextShot").addEventListener("click", () => {
    if (currentShotIndex + 1 < shots.length) seekToShot(currentShotIndex + 1, 0);
  });

  const btnLoop = document.getElementById("btnLoop");
  btnLoop.addEventListener("click", () => {
    loopShot = !loopShot;
    btnLoop.classList.toggle("btn-primary", loopShot);
  });

  // A/B (Base Layer) & A/C (Shot Version) Comparison & Base Audio Controls
  const btnABCompare = document.getElementById("btnABCompare");
  const btnACCompare = document.getElementById("btnACCompare");
  const btnBaseAudio = document.getElementById("btnBaseAudio");

  function cycleABMode() {
    if (!hasBaseMovie) {
      // Auto-select the first available reference movie in #selBaseMovie if present
      if (selBaseMovie && selBaseMovie.options.length > 1) {
        selBaseMovie.selectedIndex = 1;
        loadBaseLayerMovie(selBaseMovie.value);
      } else {
        if (projectConfigBar && projectConfigBar.style.display === "none") {
          projectConfigBar.style.display = "flex";
        }
        alert("Select or browse a Base Layer Mixdown Movie first (in the Project / Media bar at the top) to compare A/B.");
        return;
      }
    }
    if (abMode === "A" || abMode === "C" || abMode === "SPLIT_AC") abMode = "B";
    else if (abMode === "B") abMode = "SPLIT";
    else abMode = "A";
    applyABMode();
  }

  function cycleACMode() {
    const shot = shots[currentShotIndex];
    if (!shot || !shot.versions || shot.versions.length === 0) return;
    loadCVideoMedia(shot, Math.max(0, currentTimelineFrame - shot.record_start), true);
    if (abMode === "A" || abMode === "B" || abMode === "SPLIT") abMode = "C";
    else if (abMode === "C") abMode = "SPLIT_AC";
    else abMode = "A";
    applyABMode();
  }

  function toggleBaseAudio() {
    baseAudioEnabled = !baseAudioEnabled;
    if (btnBaseAudio) {
      btnBaseAudio.textContent = baseAudioEnabled ? "🔊 Base Audio: ON" : "🔇 Base Audio: OFF";
      btnBaseAudio.classList.toggle("btn-primary", baseAudioEnabled && hasBaseMovie);
    }
    syncAudioRouting();
  }

  if (btnABCompare) {
    btnABCompare.addEventListener("click", cycleABMode);
  }
  if (btnACCompare) {
    btnACCompare.addEventListener("click", cycleACMode);
  }
  if (btnBaseAudio) {
    btnBaseAudio.addEventListener("click", toggleBaseAudio);
  }

  // Draggable A|B or A|C Split Wipe Divider
  let isDraggingWipe = false;
  if (abWipeLine && videoStage) {
    abWipeLine.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      isDraggingWipe = true;
    });
    window.addEventListener("mousemove", (e) => {
      if (!isDraggingWipe || (abMode !== "SPLIT" && abMode !== "SPLIT_AC")) return;
      const rect = videoStage.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
      wipePercent = Math.max(5, Math.min(95, pct));
      activeVideo.style.clipPath = `inset(0 ${100 - wipePercent}% 0 0)`;
      abWipeLine.style.left = `${wipePercent}%`;
    });
    window.addEventListener("mouseup", () => {
      isDraggingWipe = false;
    });
  }

  // In-App Rescan (Resolve DB + Filesystem) & Proxy Builder Controls
  const btnRescan = document.getElementById("btnRescan");
  const btnMakeProxies = document.getElementById("btnMakeProxies");
  const serverStatusText = document.getElementById("serverStatusText");
  let statusPollTimer = null;

  async function triggerServerTask(endpoint, buttonEl, labelRunning) {
    if (window.location.protocol === "file:") {
      alert("To run Rescan or Build Proxies directly from the interface, please open the player via launch_player.bat (http://localhost:8080/review/).");
      return;
    }
    try {
      buttonEl.disabled = true;
      if (serverStatusText) serverStatusText.textContent = labelRunning;
      const resp = await fetch(endpoint, { method: "POST" });
      const res = await resp.json();
      if (!res.ok) {
        alert(res.error || "Could not start task.");
        buttonEl.disabled = false;
        return;
      }
      startPollingServerStatus();
    } catch (err) {
      alert("Could not reach local review server. Make sure launch_player.bat is running.");
      buttonEl.disabled = false;
      if (serverStatusText) serverStatusText.textContent = "";
    }
  }

  // Persist & Restore Timeline Playhead, Zoom, and Base Layer State across Refreshes
  const selBaseMovie = document.getElementById("selBaseMovie");
  const selBaseStartFrame = document.getElementById("selBaseStartFrame");

  function savePlaybackState() {
    try {
      const state = {
        timelineFrame: currentTimelineFrame,
        shotIndex: currentShotIndex,
        timelineZoom: timelineZoom,
        abMode: abMode,
        wipePercent: wipePercent,
        baseMoviePath: selBaseMovie ? selBaseMovie.value : "",
        baseStartFrame: baseStartFrame,
        baseAudioEnabled: baseAudioEnabled
      };
      localStorage.setItem("shotswap_playback_state", JSON.stringify(state));
    } catch (e) {
      // ignore storage quota errors
    }
  }

  // Save state whenever playhead moves or user interacts
  window.addEventListener("beforeunload", savePlaybackState);
  setInterval(savePlaybackState, 1500);

  // Scan & Proxy Status Report Panel
  const btnToggleScanReport = document.getElementById("btnToggleScanReport");
  const reportAlertBadge = document.getElementById("reportAlertBadge");
  const scanReportPanel = document.getElementById("scanReportPanel");
  const scanReportBody = document.getElementById("scanReportBody");
  const scanReportTimestamp = document.getElementById("scanReportTimestamp");
  const btnReportBuildProxies = document.getElementById("btnReportBuildProxies");
  const btnCloseScanReport = document.getElementById("btnCloseScanReport");

  function jumpToShotCode(shotCode) {
    const idx = shots.findIndex((s) => s.shot_code === shotCode);
    if (idx >= 0) {
      seekToShot(idx, 0);
    }
  }

  function renderScanReport(report, autoOpen = false) {
    if (!report || !scanReportBody) return;

    const missingCount = report.missing_proxies_count || 0;
    const newVerCount = report.new_versions_count || 0;
    const newerOnDiskCount = report.newer_on_disk_count || 0;
    const cutChangesCount = report.cut_changes_count || 0;

    if (scanReportTimestamp) {
      scanReportTimestamp.textContent = `Timeline: ${report.timeline_name || data.timeline_name || ""} • Scanned: ${report.scanned_at || "Just now"}`;
    }

    // Update header badge
    const alertTotal = missingCount + newVerCount + newerOnDiskCount;
    if (reportAlertBadge) {
      if (alertTotal > 0) {
        reportAlertBadge.style.display = "inline-block";
        reportAlertBadge.textContent = alertTotal;
        reportAlertBadge.style.background = missingCount > 0 ? "#ef4444" : "#f59e0b";
        reportAlertBadge.style.color = missingCount > 0 ? "#ffffff" : "#0f1115";
      } else {
        reportAlertBadge.style.display = "none";
      }
    }

    if (btnReportBuildProxies) {
      if (missingCount > 0) {
        btnReportBuildProxies.style.display = "inline-flex";
        btnReportBuildProxies.textContent = `⚡ Build ${missingCount} Missing Prox${missingCount === 1 ? "y" : "ies"} Now`;
      } else {
        btnReportBuildProxies.style.display = "none";
      }
    }

    scanReportBody.innerHTML = "";

    // Card 1: Web Proxy Status
    const proxyCard = document.createElement("div");
    proxyCard.className = `report-card ${missingCount > 0 ? "warn" : "ok"}`;
    if (missingCount > 0) {
      const chipsHtml = (report.missing_proxies || [])
        .map((m) => `<span class="report-shot-chip" data-shot="${m.shot_code}" title="${m.base_name} (${m.date_formatted})">${m.shot_code}: ${m.base_name}</span>`)
        .join("");
      proxyCard.innerHTML = `
        <div class="report-card-title">
          <span>⚠️ Web Proxies Needed (${missingCount})</span>
          <span style="color:#fbbf24;">Action Required</span>
        </div>
        <div style="font-size:11px; color:var(--text-muted);">${missingCount} ProRes .mov version(s) need H.264 web proxies for browser playback:</div>
        <div class="report-chip-list">${chipsHtml}</div>
      `;
    } else {
      proxyCard.innerHTML = `
        <div class="report-card-title">
          <span>✅ Web Proxies Ready</span>
          <span style="color:#34d399;">${report.total_versions || 0} / ${report.total_versions || 0} Ready</span>
        </div>
        <div style="font-size:11px; color:var(--text-muted);">All ${report.total_versions || 0} versions across ${report.total_shots || shots.length} shots have playable MP4s or web proxies.</div>
      `;
    }
    scanReportBody.appendChild(proxyCard);

    // Card 2: Brand-New Files Discovered Since Previous Scan
    const newFilesCard = document.createElement("div");
    newFilesCard.className = `report-card ${newVerCount > 0 ? "info" : ""}`;
    if (newVerCount > 0) {
      const chipsHtml = (report.new_versions || [])
        .map((nv) => `<span class="report-shot-chip" data-shot="${nv.shot_code}" title="${nv.base_name} (${nv.date_formatted})">${nv.shot_code}: ${nv.base_name}</span>`)
        .join("");
      newFilesCard.innerHTML = `
        <div class="report-card-title">
          <span>🆕 New Files Found on Disk (${newVerCount})</span>
        </div>
        <div style="font-size:11px; color:var(--text-muted);">Added since previous scan (click to jump to shot):</div>
        <div class="report-chip-list">${chipsHtml}</div>
      `;
    } else {
      newFilesCard.innerHTML = `
        <div class="report-card-title">
          <span>📂 New Files Since Last Scan (0)</span>
        </div>
        <div style="font-size:11px; color:var(--text-muted);">No brand-new files were added to shot folders since the last scan.</div>
      `;
    }
    scanReportBody.appendChild(newFilesCard);

    // Card 3: Shots Where a Newer Version Exists on Disk Than Active Resolve Cut
    const newerCard = document.createElement("div");
    newerCard.className = `report-card ${newerOnDiskCount > 0 ? "info" : "ok"}`;
    if (newerOnDiskCount > 0) {
      const chipsHtml = (report.newer_on_disk || [])
        .map((nd) => `<span class="report-shot-chip" data-shot="${nd.shot_code}" title="Cut in Resolve: ${nd.active_clip}\nNewest on Disk: ${nd.latest_version} (${nd.latest_date})">${nd.shot_code} → ${nd.latest_version}</span>`)
        .join("");
      newerCard.innerHTML = `
        <div class="report-card-title">
          <span>🔔 Newer Versions Than Cut (${newerOnDiskCount} Shots)</span>
          <button class="btn btn-xs" id="btnSwitchAllToLatest" title="Switch all ${newerOnDiskCount} shots in the player to their newest version on disk">Use Latest (${newerOnDiskCount})</button>
        </div>
        <div style="font-size:11px; color:var(--text-muted);">These shots have a newer file on disk than what is currently cut in Resolve:</div>
        <div class="report-chip-list">${chipsHtml}</div>
      `;
    } else {
      newerCard.innerHTML = `
        <div class="report-card-title">
          <span>✅ Active Cut Uses Latest Versions</span>
        </div>
        <div style="font-size:11px; color:var(--text-muted);">Every shot in the Resolve timeline is already using the newest version on disk.</div>
      `;
    }
    scanReportBody.appendChild(newerCard);

    // Card 4: Cut Changes from Resolve DB
    if (cutChangesCount > 0) {
      const cutCard = document.createElement("div");
      cutCard.className = "report-card info";
      const chipsHtml = (report.cut_changes || [])
        .map((cc) => `<span class="report-shot-chip" data-shot="${cc.shot_code}" title="${cc.old_clip} → ${cc.new_clip} (${cc.track})">${cc.shot_code}: ${cc.new_clip} (${cc.track})</span>`)
        .join("");
      cutCard.innerHTML = `
        <div class="report-card-title">
          <span>🎬 Resolve Cut Updated (${cutChangesCount} Shots)</span>
        </div>
        <div class="report-chip-list">${chipsHtml}</div>
      `;
      scanReportBody.appendChild(cutCard);
    }

    // Wire up click-to-jump on all shot chips inside report
    scanReportBody.querySelectorAll(".report-shot-chip[data-shot]").forEach((chip) => {
      chip.addEventListener("click", () => {
        jumpToShotCode(chip.getAttribute("data-shot"));
      });
    });

    // Wire up "Use Latest" button if present
    const btnSwitchAll = document.getElementById("btnSwitchAllToLatest");
    if (btnSwitchAll) {
      btnSwitchAll.addEventListener("click", () => {
        (report.newer_on_disk || []).forEach((nd) => {
          const s = shots.find((sh) => sh.shot_code === nd.shot_code);
          if (s && s.versions && s.versions.length > 0) {
            s.active_version_index = 0; // index 0 is newest sorted by mtime
          }
        });
        saveVersionChoices();
        renderTimelineStrip();
        updateInspector();
        updateOverlays();
        loadShotMedia(activeVideo, shots[currentShotIndex], currentTimelineFrame - shots[currentShotIndex].record_start);
      });
    }

    if (autoOpen && scanReportPanel) {
      scanReportPanel.style.display = "flex";
    }
  }

  if (btnToggleScanReport && scanReportPanel) {
    btnToggleScanReport.addEventListener("click", () => {
      const isHidden = scanReportPanel.style.display === "none";
      scanReportPanel.style.display = isHidden ? "flex" : "none";
      btnToggleScanReport.classList.toggle("btn-primary", isHidden);
    });
  }
  if (btnCloseScanReport && scanReportPanel) {
    btnCloseScanReport.addEventListener("click", () => {
      scanReportPanel.style.display = "none";
      if (btnToggleScanReport) btnToggleScanReport.classList.remove("btn-primary");
    });
  }
  if (btnReportBuildProxies) {
    btnReportBuildProxies.addEventListener("click", () => {
      triggerServerTask("/api/generate-proxies", btnMakeProxies || btnReportBuildProxies, "Starting GPU proxy generator...");
    });
  }

  let pendingProxyToast = false;

  function showCompletionToast(message, isSuccess = true) {
    let toast = document.getElementById("proxyReadyToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "proxyReadyToast";
      toast.style.cssText = "position:fixed; top:56px; right:20px; z-index:9999; padding:10px 16px; border-radius:6px; font-size:13px; font-weight:700; box-shadow:0 6px 20px rgba(0,0,0,0.65); display:flex; align-items:center; gap:10px; transition:opacity 0.3s;";
      document.body.appendChild(toast);
    }
    toast.style.background = isSuccess ? "#065f46" : "#78350f";
    toast.style.border = isSuccess ? "1px solid #10b981" : "1px solid #f59e0b";
    toast.style.color = "#f8fafc";
    toast.style.opacity = "1";
    toast.innerHTML = `<span>${message}</span><button style="background:transparent;border:none;color:#cbd5e1;cursor:pointer;font-size:14px;" onclick="this.parentElement.style.opacity='0'">✕</button>`;
    setTimeout(() => {
      if (toast) toast.style.opacity = "0";
    }, 7000);
  }

  function startPollingServerStatus() {
    if (statusPollTimer) clearInterval(statusPollTimer);
    statusPollTimer = setInterval(async () => {
      try {
        const resp = await fetch("/api/status");
        const st = await resp.json();
        const line = st.last_line || "";
        if (serverStatusText) {
          serverStatusText.textContent = line;
          serverStatusText.style.color = st.running ? "#38bdf8" : "#34d399";
        }

        const curTask = st.task_type || st.task || "";

        // Show live [X/Y] counter right on the Build Proxies or Export Burn-In button while running
        if (st.running && (curTask === "proxies" || curTask === "generate_proxies")) {
          const m = line.match(/\[(\d+\/\d+)\]/);
          const prog = m ? ` [${m[1]}]` : "...";
          if (btnMakeProxies) btnMakeProxies.textContent = `⏳ Building${prog}`;
          if (btnReportBuildProxies) btnReportBuildProxies.textContent = `⏳ Building Proxies${prog}`;
        } else if (st.running && curTask === "export_movie") {
          const m = line.match(/\[(\d+\/\d+)\]/);
          const prog = m ? ` [${m[1]}]` : "...";
          if (btnExportBurninMovie) btnExportBurninMovie.textContent = `⏳ Rendering Burn-In Movie${prog}`;
        }

        if (!st.running) {
          clearInterval(statusPollTimer);
          statusPollTimer = null;
          if (btnRescan) btnRescan.disabled = false;
          if (btnMakeProxies) {
            btnMakeProxies.disabled = false;
            btnMakeProxies.textContent = "⚡ Build Proxies";
          }
          if (btnExportBurninMovie) {
            btnExportBurninMovie.disabled = false;
            btnExportBurninMovie.textContent = "🎥 Render Proxy Cut Movie w/ Burn-Ins (.mp4)";
          }
          if (btnPushUpdatesToResolve) {
            btnPushUpdatesToResolve.disabled = false;
            btnPushUpdatesToResolve.textContent = '🚀 Update Open Resolve Timeline — Place "What\'s New" on New Track';
          }
          if (btnExportWhatsNewDRT) {
            btnExportWhatsNewDRT.disabled = false;
            btnExportWhatsNewDRT.textContent = '📦 Export "What\'s New" DRT — Diff Only (.drt)';
          }

          if (curTask === "export_movie" || curTask === "update_timeline" || curTask === "export_drt") {
            if (st.exit_code === 0) {
              showCompletionToast(`✅ ${line}`);
            } else {
              showCompletionToast(`⚠️ ${line}`, false);
            }
            return;
          }

          // If proxy build just finished, trigger a quick --fast rescan so missing_proxies_count updates to 0
          if (curTask === "proxies" || curTask === "generate_proxies") {
            pendingProxyToast = true;
            await fetch("/api/resolve/load", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                project_db: selResolveProject ? selResolveProject.value : "",
                timeline_name: selResolveTimeline ? selResolveTimeline.value : "",
                media_source: inpMediaSource ? inpMediaSource.value : "",
                fast: true
              })
            });
            setTimeout(startPollingServerStatus, 400);
            return;
          }

          // Reload updated manifest live from server while preserving current timeline frame + user slips/versions
          const savedFrame = currentTimelineFrame;
          const mResp = await fetch("/api/manifest");
          const mJson = await mResp.json();
          if (mJson.ok && mJson.manifest && mJson.manifest.shots) {
            const savedVersionsRaw = localStorage.getItem("shotswap_version_choices");
            const savedVersionsMap = savedVersionsRaw ? JSON.parse(savedVersionsRaw) : {};
            const savedSlipsRaw = localStorage.getItem("shotswap_slip_choices");
            const savedSlipsMap = savedSlipsRaw ? JSON.parse(savedSlipsRaw) : {};
            const savedCRaw = localStorage.getItem("shotswap_c_version_choices");
            const savedCMap = savedCRaw ? JSON.parse(savedCRaw) : {};

            const newShots = mJson.manifest.shots;
            shots.length = 0;
            newShots.forEach((ns) => {
              ns.baseline_version_index = ns.active_version_index || 0;
              ns.baseline_source_in = ns.source_in || 0;
              if (savedVersionsMap[ns.shot_code] !== undefined) {
                ns.active_version_index = savedVersionsMap[ns.shot_code];
              }
              if (savedSlipsMap[ns.shot_code] !== undefined) {
                ns.source_in = Math.max(0, parseInt(savedSlipsMap[ns.shot_code], 10) || 0);
                ns.source_out = ns.source_in + ns.duration;
              }
              if (savedCMap[ns.shot_code] !== undefined) {
                ns.c_version_index = parseInt(savedCMap[ns.shot_code], 10);
              }
              shots.push(ns);
            });
            const tagEl = document.querySelector(".timeline-tag");
            if (tagEl && mJson.manifest.timeline_name) {
              tagEl.textContent = `${shots.length} Shots | ${mJson.manifest.timeline_name}`;
            }
            renderTimelineStrip();
            jumpToFrame(savedFrame);
            if (mJson.manifest.scan_report) {
              renderScanReport(mJson.manifest.scan_report, true);
              if (pendingProxyToast) {
                pendingProxyToast = false;
                const rem = mJson.manifest.scan_report.missing_proxies_count || 0;
                if (rem === 0) {
                  showCompletionToast("✅ All Web Proxies Ready! Every shot version is now ready for instant playback.");
                  if (serverStatusText) serverStatusText.textContent = "✅ All Web Proxies Ready!";
                } else {
                  showCompletionToast(`⚠️ Proxy batch finished (${rem} remaining).`, false);
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn("Status poll error:", e);
      }
    }, 1000);
  }

  if (btnRescan) {
    btnRescan.addEventListener("click", () => {
      triggerServerTask("/api/rescan", btnRescan, "Syncing Resolve DB & scanning shots...");
    });
  }

  if (btnMakeProxies) {
    btnMakeProxies.addEventListener("click", () => {
      triggerServerTask("/api/generate-proxies", btnMakeProxies, "Starting GPU proxy generator...");
    });
  }

  // Resolve Project / Timeline / Media Source / Base Layer Selector Bar & Native Dialogs
  const btnToggleProjectBar = document.getElementById("btnToggleProjectBar");
  const projectConfigBar = document.getElementById("projectConfigBar");
  const selResolveProject = document.getElementById("selResolveProject");
  const selResolveTimeline = document.getElementById("selResolveTimeline");
  const inpMediaSource = document.getElementById("inpMediaSource");
  const btnBrowseResolveDB = document.getElementById("btnBrowseResolveDB");
  const btnBrowseMediaSource = document.getElementById("btnBrowseMediaSource");
  const btnBrowseBaseMovie = document.getElementById("btnBrowseBaseMovie");
  const btnLoadSelectedTimeline = document.getElementById("btnLoadSelectedTimeline");
  const btnLoadAndFullScan = document.getElementById("btnLoadAndFullScan");

  function loadBaseLayerMovie(filePath) {
    if (!videoBase) return;
    if (!filePath) {
      hasBaseMovie = false;
      videoBase.removeAttribute("src");
      abMode = "A";
      applyABMode();
      syncAudioRouting();
      savePlaybackState();
      return;
    }
    hasBaseMovie = true;
    videoBase.src = `/api/external-media?path=${encodeURIComponent(filePath)}`;
    videoBase.playbackRate = playbackSpeed;
    syncAudioRouting();
    syncBaseVideo(true);
    if (btnBaseAudio) {
      btnBaseAudio.classList.toggle("btn-primary", baseAudioEnabled);
    }
    savePlaybackState();
  }

  if (selBaseMovie) {
    selBaseMovie.addEventListener("change", (e) => {
      loadBaseLayerMovie(e.target.value);
    });
  }

  if (selBaseStartFrame) {
    selBaseStartFrame.addEventListener("change", (e) => {
      baseStartFrame = parseInt(e.target.value, 10) || 86208;
      syncBaseVideo(true);
      savePlaybackState();
    });
  }

  // Native Folder & File Picker Dialogs via Local Server
  if (btnBrowseMediaSource) {
    btnBrowseMediaSource.addEventListener("click", async () => {
      try {
        btnBrowseMediaSource.disabled = true;
        const resp = await fetch("/api/dialog/folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            initial_dir: inpMediaSource ? inpMediaSource.value.trim() : "",
            title: "Select Media Source Root Folder (Shot Folders)"
          })
        });
        const res = await resp.json();
        if (res.ok && res.path && inpMediaSource) {
          inpMediaSource.value = res.path;
        }
      } catch (e) {
        alert("Could not open folder picker. Make sure server.py is running.");
      } finally {
        btnBrowseMediaSource.disabled = false;
      }
    });
  }

  if (btnBrowseResolveDB) {
    btnBrowseResolveDB.addEventListener("click", async () => {
      try {
        btnBrowseResolveDB.disabled = true;
        const resp = await fetch("/api/dialog/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            initial_dir: "F:\\RESOLVE PROJECT",
            title: "Select DaVinci Resolve Project.db",
            kind: "db"
          })
        });
        const res = await resp.json();
        if (res.ok && res.path && selResolveProject) {
          let existing = Array.from(selResolveProject.options).find((o) => o.value === res.path);
          if (!existing) {
            existing = document.createElement("option");
            existing.value = res.path;
            existing.textContent = res.path;
            selResolveProject.appendChild(existing);
          }
          existing.selected = true;
          selResolveProject.dispatchEvent(new Event("change"));
        }
      } catch (e) {
        alert("Could not open file picker. Make sure server.py is running.");
      } finally {
        btnBrowseResolveDB.disabled = false;
      }
    });
  }

  if (btnBrowseBaseMovie) {
    btnBrowseBaseMovie.addEventListener("click", async () => {
      try {
        btnBrowseBaseMovie.disabled = true;
        const resp = await fetch("/api/dialog/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            initial_dir: "F:\\RESOLVE PROJECT\\RESOLVE 19\\EDL and Ref",
            title: "Select Base Layer Mixdown Movie (.mov / .mp4)",
            kind: "video"
          })
        });
        const res = await resp.json();
        if (res.ok && res.path && selBaseMovie) {
          let existing = Array.from(selBaseMovie.options).find((o) => o.value === res.path);
          if (!existing) {
            existing = document.createElement("option");
            existing.value = res.path;
            existing.textContent = res.path.split(/[\\/]/).pop();
            selBaseMovie.appendChild(existing);
          }
          existing.selected = true;
          loadBaseLayerMovie(res.path);
        }
      } catch (e) {
        alert("Could not open file picker. Make sure server.py is running.");
      } finally {
        btnBrowseBaseMovie.disabled = false;
      }
    });
  }

  async function initResolveProjectSelector() {
    if (window.location.protocol === "file:") return;
    try {
      const resp = await fetch("/api/resolve/projects");
      const info = await resp.json();
      if (info.ok) {
        if (selResolveProject && info.projects) {
          selResolveProject.innerHTML = "";
          info.projects.forEach((p) => {
            const opt = document.createElement("option");
            opt.value = p.db_path;
            opt.textContent = p.name;
            if (p.db_path === info.current_project_db) opt.selected = true;
            selResolveProject.appendChild(opt);
          });
        }

        if (selResolveTimeline && info.timelines) {
          populateTimelineDropdown(info.timelines, info.current_timeline || data.timeline_name);
        }

        if (inpMediaSource && info.current_media_source) {
          inpMediaSource.value = info.current_media_source;
        }
      }

      // Populate Reference / Base Layer Mixdown movies (loaded on demand when selected or when A/B is clicked)
      if (selBaseMovie) {
        const refResp = await fetch("/api/resolve/ref-movies");
        const refInfo = await refResp.json();
        if (refInfo.ok && refInfo.movies) {
          selBaseMovie.innerHTML = `<option value="">-- Select Base Layer Movie (or click 🌓 A/B to auto-load latest) --</option>`;
          refInfo.movies.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = m.path;
            opt.textContent = `${m.name} (${m.date_formatted || ""} • ${m.size_mb} MB)`;
            selBaseMovie.appendChild(opt);
          });
        }
      }
    } catch (e) {
      console.warn("Could not load Resolve projects list:", e);
    }
  }

  function populateTimelineDropdown(timelines, selectedName) {
    if (!selResolveTimeline) return;
    selResolveTimeline.innerHTML = "";
    timelines.forEach((tl) => {
      const opt = document.createElement("option");
      opt.value = tl.name;
      opt.textContent = tl.name;
      if (tl.name === selectedName) opt.selected = true;
      selResolveTimeline.appendChild(opt);
    });
  }

  if (btnToggleProjectBar && projectConfigBar) {
    btnToggleProjectBar.addEventListener("click", () => {
      const isHidden = projectConfigBar.style.display === "none";
      projectConfigBar.style.display = isHidden ? "flex" : "none";
      btnToggleProjectBar.classList.toggle("btn-primary", isHidden);
      if (isHidden && selResolveProject && selResolveProject.options.length <= 1) {
        // Defer Project.db / Reference movie list discovery until after initial frame loads
        setTimeout(initResolveProjectSelector, 800);
      }
    });
  }

  if (selResolveProject) {
    selResolveProject.addEventListener("change", async (e) => {
      const dbPath = e.target.value;
      if (!dbPath) return;
      try {
        selResolveTimeline.innerHTML = `<option value="">Reading timelines from Project.db...</option>`;
        const resp = await fetch(`/api/resolve/timelines?project_db=${encodeURIComponent(dbPath)}`);
        const res = await resp.json();
        if (res.ok && res.timelines) {
          populateTimelineDropdown(res.timelines, "");
        }
      } catch (err) {
        console.warn("Failed to load timelines for project:", err);
      }
    });
  }

  async function loadSelectedResolveTimeline(fastMode) {
    if (window.location.protocol === "file:") {
      alert("Please launch via launch_player.bat (http://localhost:8080/review/) to query Resolve Project.db.");
      return;
    }
    const projDb = selResolveProject ? selResolveProject.value : "";
    const tlName = selResolveTimeline ? selResolveTimeline.value : "";
    const mediaSrc = inpMediaSource ? inpMediaSource.value.trim() : "";

    try {
      if (btnLoadSelectedTimeline) btnLoadSelectedTimeline.disabled = true;
      if (btnLoadAndFullScan) btnLoadAndFullScan.disabled = true;
      if (serverStatusText) serverStatusText.textContent = `Loading timeline '${tlName}'...`;

      const resp = await fetch("/api/resolve/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_db: projDb,
          timeline_name: tlName,
          media_source: mediaSrc,
          fast: fastMode
        })
      });
      const res = await resp.json();
      if (!res.ok) {
        alert(res.error || "Could not load timeline.");
      } else {
        startPollingServerStatus();
      }
    } catch (err) {
      alert("Error communicating with local server: " + err);
    } finally {
      if (btnLoadSelectedTimeline) btnLoadSelectedTimeline.disabled = false;
      if (btnLoadAndFullScan) btnLoadAndFullScan.disabled = false;
    }
  }

  if (btnLoadSelectedTimeline) {
    btnLoadSelectedTimeline.addEventListener("click", () => loadSelectedResolveTimeline(true));
  }
  if (btnLoadAndFullScan) {
    btnLoadAndFullScan.addEventListener("click", () => loadSelectedResolveTimeline(false));
  }

  // Defer Project.db / Reference movie list discovery until after initial frame loads
  setTimeout(initResolveProjectSelector, 800);

  speedSelect.addEventListener("change", (e) => {
    playbackSpeed = parseFloat(e.target.value);
    activeVideo.playbackRate = playbackSpeed;
    preloadVideo.playbackRate = playbackSpeed;
    if (videoC) videoC.playbackRate = playbackSpeed;
    if (videoBase) videoBase.playbackRate = playbackSpeed;
  });

  function toggleFullscreen() {
    const stage = document.querySelector(".player-section");
    if (!document.fullscreenElement) {
      stage.requestFullscreen().catch(console.warn);
    } else {
      document.exitFullscreen().catch(console.warn);
    }
  }

  // Sidebar Tab Switching
  document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.getAttribute("data-tab");
      document.getElementById("tab-inspector").style.display = target === "inspector" ? "flex" : "none";
      document.getElementById("tab-notes").style.display = target === "notes" ? "flex" : "none";
      document.getElementById("tab-export").style.display = target === "export" ? "flex" : "none";
    });
  });

  // Initialize & Restore Saved Playhead Position + Scan Report
  renderTimelineStrip();
  renderNotes();
  if (data.scan_report) {
    // Auto-open report on load if proxies are missing
    renderScanReport(data.scan_report, (data.scan_report.missing_proxies_count || 0) > 0);
  }

  let restoredPosition = false;
  try {
    const rawState = localStorage.getItem("shotswap_playback_state");
    if (rawState) {
      const st = JSON.parse(rawState);
      if (st.baseStartFrame && selBaseStartFrame) {
        baseStartFrame = parseInt(st.baseStartFrame, 10) || 86208;
        selBaseStartFrame.value = String(baseStartFrame);
      }
      if (typeof st.baseAudioEnabled === "boolean") {
        baseAudioEnabled = st.baseAudioEnabled;
        if (btnBaseAudio) {
          btnBaseAudio.textContent = baseAudioEnabled ? "🔊 Base Audio: ON" : "🔇 Base Audio: OFF";
        }
      }
      if (typeof st.wipePercent === "number") {
        wipePercent = st.wipePercent;
      }
      if (st.timelineZoom && st.timelineZoom > 1.0) {
        setTimelineZoom(st.timelineZoom);
      }
      if (typeof st.timelineFrame === "number" && st.timelineFrame >= minRecordFrame && st.timelineFrame < maxRecordFrame) {
        jumpToFrame(st.timelineFrame);
        restoredPosition = true;
      }
    }
  } catch (e) {
    console.warn("Could not restore playback state:", e);
  }

  if (!restoredPosition) {
    seekToShot(0, 0);
  }
})();
