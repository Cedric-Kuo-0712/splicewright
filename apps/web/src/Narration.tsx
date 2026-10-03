import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@splicewright/core";
import { playhead, refresh } from "./store.ts";

type Engine = "kokoro" | "breezyvoice";
type Voice = { id: string; name: string; language: string };
type Language = { id: string; name: string; ready: boolean };
type Profile = { id: string; name: string; transcript: string; durationSeconds: number };
type KokoroStatus = { ready: boolean; voices: Voice[]; languages: Language[]; setupCommand: string; detail?: string };
type BreezyStatus = { ready: boolean; voices: Profile[]; setupCommand: string; detail?: string; device?: string };
type TtsStatus = KokoroStatus & { engines?: { kokoro: KokoroStatus; breezyvoice: BreezyStatus } };
const message = (cause: unknown) => cause instanceof Error ? cause.message : "旁白服務無法使用。";
async function responseJson(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : data?.error?.message || "旁白服務無法使用。");
  return data;
}

export function Narration({ p, readOnly = false }: { p: Project; readOnly?: boolean }) {
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [engine, setEngine] = useState<Engine>("kokoro");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const recordingRef = useRef<HTMLInputElement>(null);
  const [startingInstall, setStartingInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installDetail, setInstallDetail] = useState("");
  const [text, setText] = useState("");
  const [language, setLanguage] = useState("en-us");
  const [voice, setVoice] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [speed, setSpeed] = useState(1);
  const [trackId, setTrackId] = useState("");
  const [name, setName] = useState("");
  const [recording, setRecording] = useState<File | null>(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const busy = generating || saving || installing || startingInstall;
  const audioTracks = p.tracks.filter((track) => track.kind === "audio");
  const kokoro = status?.engines?.kokoro ?? status;
  const breezy = status?.engines?.breezyvoice;
  const profiles = breezy?.voices ?? [];
  const voices = useMemo(() => (kokoro?.voices ?? []).filter((item) => item.language === language), [kokoro, language]);
  const current = engine === "kokoro" ? kokoro : breezy;

  async function loadStatus(signal?: AbortSignal) {
    const data = await responseJson(await fetch("/api/tts", { signal }));
    if (!data || typeof data.ready !== "boolean" || !Array.isArray(data.voices) || !Array.isArray(data.languages)) throw new Error("旁白服務回傳了無法辨識的狀態。");
    if (signal?.aborted) return;
    setStatus(data); setStatusError("");
    const languages: Language[] = data.engines?.kokoro?.languages ?? data.languages;
    setLanguage((selected) => languages.some((item) => item.id === selected && item.ready) ? selected : languages.find((item) => item.ready)?.id ?? languages[0]?.id ?? "en-us");
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal).catch((cause) => { if (!controller.signal.aborted) setStatusError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoadingStatus(false); });
    return () => controller.abort();
  }, []);
  useEffect(() => { if (!voices.some((item) => item.id === voice)) setVoice(voices[0]?.id ?? ""); }, [voices, voice]);
  useEffect(() => { if (!profiles.some((item) => item.id === voiceId)) setVoiceId(profiles[0]?.id ?? ""); }, [breezy, voiceId]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/tts/setup?engine=${engine}`, { signal: controller.signal }).then(responseJson).then((job) => {
      if (!controller.signal.aborted && job.state === "running") { setInstalling(true); setInstallDetail(job.detail); }
    }).catch(() => {});
    return () => controller.abort();
  }, [engine]);
  useEffect(() => {
    if (!installing) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function progress() {
      try {
        const job = await responseJson(await fetch(`/api/tts/setup?engine=${engine}`, { signal: controller.signal }));
        if (controller.signal.aborted) return;
        setInstallDetail(job.detail);
        if (job.state === "ready") { await loadStatus(controller.signal); setInstalling(false); return; }
        if (job.state === "failed") { setError(job.detail); setInstalling(false); return; }
        if (job.state !== "running") { setInstalling(false); setError("安裝狀態已中斷，請重新檢查語音服務。"); return; }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(message(cause)); setInstalling(false); return;
      }
      timer = setTimeout(() => void progress(), 1500);
    }
    void progress();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [installing, engine]);

  const languageReady = !!kokoro?.languages.some((item) => item.id === language && item.ready);
  const selectedTrack = audioTracks.find((item) => item.id === trackId);
  const trackReady = !trackId || (!!selectedTrack && !selectedTrack.locked);
  const maximum = engine === "breezyvoice" ? 300 : 2000;
  const voiceReady = engine === "breezyvoice" ? !!breezy?.ready && profiles.some((item) => item.id === voiceId) : languageReady && !!voice;
  const canGenerate = !readOnly && !busy && !loadingStatus && trackReady && voiceReady && !!text.trim() && text.trim().length <= maximum;
  async function install() {
    if (readOnly || busy || busyRef.current) return;
    busyRef.current = true; setStartingInstall(true); setError("");
    try {
      const job = await responseJson(await fetch("/api/tts/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine, languages: ["en-us", "zh"] }) }));
      setInstallDetail(job.detail); setInstalling(job.state === "running");
      if (job.state === "ready") await loadStatus();
      else if (job.state === "failed") setError(job.detail);
    } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setStartingInstall(false); }
  }
  async function saveVoice() {
    if (readOnly || busy || busyRef.current || !recording || !name.trim() || !transcript.trim()) return;
    if (recording.size > 20 * 1024 * 1024) { setError("錄音檔不能超過 20 MB。"); return; }
    busyRef.current = true; setSaving(true); setError("");
    try {
      const form = new FormData(); form.set("audio", recording); form.set("name", name.trim()); form.set("transcript", transcript.trim());
      const profile = await responseJson(await fetch("/api/tts/voices", { method: "POST", body: form }));
      await loadStatus(); setVoiceId(profile.id); setName(""); setTranscript(""); setRecording(null);
      if (recordingRef.current) recordingRef.current.value = "";
    } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setSaving(false); }
  }
  async function removeVoice() {
    if (readOnly || busy || busyRef.current || !voiceId) return;
    busyRef.current = true; setSaving(true); setError("");
    try {
      await responseJson(await fetch("/api/tts/voices", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId }) }));
      await loadStatus();
    } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setSaving(false); }
  }
  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!canGenerate || busyRef.current) return;
    busyRef.current = true; setGenerating(true); setError("");
    try {
      const data = await responseJson(await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        engine, text: text.trim(), ...(engine === "breezyvoice" ? { voiceId } : { language, voice, speed }),
        at: playhead.get().frame, ...(trackId ? { trackId } : {}), base: p.revision,
      }) }));
      await refresh(); setText("");
      if (Array.isArray(data.warnings) && data.warnings.length) setError(`旁白已加入時間軸，但素材準備未完成：${data.warnings.join("；")}`);
    } catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setGenerating(false); }
  }

  return <section className="feature-create narration" aria-labelledby="narration-title" data-ui-control="narration">
    <h3 id="narration-title">旁白</h3><p className="dim">輸入文字，產生旁白並加入目前播放頭位置。</p>
    <label className="field"><span>語音引擎</span><select value={engine} disabled={readOnly || busy} onChange={(event) => { setEngine(event.target.value as Engine); setError(""); setInstallDetail(""); }}>
      <option value="kokoro">Kokoro · 英文／中文預設音色</option><option value="breezyvoice">BreezyVoice · 中文聲音複製</option>
    </select></label>
    {loadingStatus && <p className="dim" role="status">正在檢查旁白服務…</p>}
    {statusError && <p role="alert">{statusError}</p>}
    {!loadingStatus && !current?.ready && <div className="narration-unavailable" role="status">
      <strong>此語音引擎尚未設定</strong>
      <p>{engine === "breezyvoice" ? "安裝會下載數 GB 的依賴與模型。Windows 請在 WSL2 執行編輯器。" : "安裝英文與中文語音模型，完成後可離線使用。"}</p>
      <button type="button" disabled={readOnly || busy} onClick={() => void install()}>安裝 {engine === "breezyvoice" ? "BreezyVoice" : "Kokoro"}</button>
      {current?.detail && <p className="dim">{current.detail}</p>}
    </div>}
    {installing && <p className="dim narration-progress" role="status">{installDetail || "正在安裝依賴與模型…"}</p>}
    <form onSubmit={generate}>
      {engine === "kokoro" && kokoro && <>
        <label className="field"><span>語言</span><select value={language} disabled={readOnly || busy || !kokoro.languages.length} onChange={(event) => setLanguage(event.target.value)}>
          {kokoro.languages.map((item) => <option key={item.id} value={item.id} disabled={!item.ready}>{item.name}{item.ready ? "" : "（尚未設定）"}</option>)}
        </select></label>
        {kokoro.ready && kokoro.languages.some((item) => !item.ready) && <button type="button" disabled={readOnly || busy} onClick={() => void install()}>安裝其餘英文／中文語言</button>}
        <label className="field"><span>音色</span><select value={voice} disabled={readOnly || busy || !voices.length} onChange={(event) => setVoice(event.target.value)}>
          {voices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="field"><span>速度</span><select value={speed} disabled={readOnly || busy} onChange={(event) => setSpeed(Number(event.target.value))}>
          <option value={0.8}>慢</option><option value={1}>標準</option><option value={1.2}>快</option>
        </select></label>
      </>}
      {engine === "breezyvoice" && <>
        <label className="field"><span>已儲存聲音</span><select value={voiceId} disabled={readOnly || busy || !profiles.length} onChange={(event) => setVoiceId(event.target.value)}>
          {!profiles.length && <option value="">請先新增參考錄音</option>}{profiles.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.durationSeconds.toFixed(1)} 秒</option>)}
        </select></label>
        <button type="button" disabled={readOnly || busy || !voiceId} onClick={() => void removeVoice()}>移除此聲音</button>
        <details className="narration-reference"><summary>新增參考錄音</summary>
          <p className="dim">單一說話者、沒有背景音樂，建議 15–20 秒（接受 3–30 秒）。儲存後可重複使用；不會持續訓練模型。</p>
          <label className="field"><span>聲音名稱</span><input maxLength={100} value={name} disabled={readOnly || busy} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>參考錄音（最多 20 MB）</span><input ref={recordingRef} type="file" accept=".wav,.mp3,.m4a,.aac,.flac,.ogg" disabled={readOnly || busy} onChange={(event) => setRecording(event.target.files?.[0] ?? null)} /></label>
          <label className="field"><span>錄音逐字稿</span><textarea rows={4} maxLength={2000} value={transcript} disabled={readOnly || busy} onChange={(event) => setTranscript(event.target.value)} placeholder="填寫錄音中實際說出的每個字" /></label>
          <button type="button" disabled={readOnly || busy || !breezy?.ready || !recording || !name.trim() || !transcript.trim()} onClick={() => void saveVoice()}>{saving ? "正在儲存…" : "儲存聲音"}</button>
        </details>
      </>}
      <label className="field"><span>旁白文字（最多 {maximum} 字元）</span><textarea rows={5} maxLength={maximum} value={text} disabled={readOnly || busy} onChange={(event) => setText(event.target.value)} placeholder="輸入或貼上要朗讀的文字" /></label>
      <label className="field"><span>音軌</span><select value={trackId} disabled={readOnly || busy} onChange={(event) => setTrackId(event.target.value)}>
        <option value="">自動選擇音軌</option>{audioTracks.map((track) => <option key={track.id} value={track.id} disabled={!!track.locked}>{track.name}{track.locked ? "（已鎖定）" : ""}</option>)}
      </select></label>
      {!trackReady && <p role="alert">所選音軌已鎖定或不存在，請重新選擇音軌。</p>}
      {error && <p className="narration-error" role="alert">{error}</p>}
      <button type="submit" disabled={!canGenerate}>{generating ? "正在產生旁白…" : "產生並加入時間軸"}</button>
      {generating && <p className="dim" role="status">正在本機產生語音，完成後會加入音訊片段。BreezyVoice 可能需要數分鐘。</p>}
    </form>
  </section>;
}
