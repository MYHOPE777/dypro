import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  History,
  Mic,
  MonitorUp,
  Package,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  QrCode,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { LiveSessionClient } from './clients/liveSessionClient';
import { SessionReviewClient } from './clients/sessionReviewClient';
import { CatalogClient } from './clients/catalogClient';
import { DisplayLinkClient, type DisplayLink } from './clients/displayLinkClient';
import { AuthClient } from './clients/authClient';
import { V2_AUTH_REQUIRED_EVENT } from './clients/authHeaders';
import { DEFAULT_PRODUCT, PRODUCTS } from './shared/products';
import type { ComplianceResult, ComplianceRule, CoachPurpose, PresenterPhrase, PresenterProfile, Product, TranscriptSegment } from './shared/types';
import type { LiveCommand, LiveSessionSnapshot, SessionReview, SessionSummary } from './shared/v2';
import type { AudioTrack } from './shared/v2Audio';

const EMPTY: LiveSessionSnapshot = {
  sessionId: '', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '默认主播', lifecycle: 'idle',
  product: DEFAULT_PRODUCT, lineup: PRODUCTS, partialTranscript: '', transcriptHistory: [], latestCompliance: null, alerts: [], coachSuggestions: [], coachPending: false,
  riskProfile: 'balanced', stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 }, contentRevision: 0, latestSequence: 0, createdAt: Date.now(), updatedAt: Date.now(),
};

function currentDisplayAlias(): string | undefined {
  const match = window.location.pathname.match(/^\/screen\/([a-z0-9]{8})\/?$/iu);
  return match?.[1]?.toUpperCase();
}

function currentSessionId(useStoredSession = true): string | undefined {
  return new URLSearchParams(window.location.search).get('session')
    ?? (useStoredSession ? localStorage.getItem('v2-live-session') : null)
    ?? undefined;
}

function useLive(role: 'operator' | 'display') {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [products, setProducts] = useState<Product[]>(PRODUCTS);
  const [status, setStatus] = useState('正在连接');
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<LiveSessionClient | null>(null);

  useEffect(() => {
    const displayAlias = role === 'display' ? currentDisplayAlias() : undefined;
    const client = new LiveSessionClient({ role, roomId: 'room-default', displayAlias, sessionId: currentSessionId(!displayAlias) });
    clientRef.current = client;
    const unsubscribe = client.subscribe((next) => {
      setSnapshot(next);
      setProducts([...client.products]);
      setConnected(client.connected);
      if (next.sessionId) {
        localStorage.setItem('v2-live-session', next.sessionId);
        const query = new URLSearchParams(window.location.search);
        if (role === 'operator' && query.get('session') !== next.sessionId) {
          query.set('session', next.sessionId);
          window.history.replaceState(null, '', `${window.location.pathname}?${query}`);
        }
      }
    });
    const unsubscribeStatus = client.onStatus((next) => { setStatus(next); setConnected(client.connected); });
    client.connect();
    return () => { unsubscribe(); unsubscribeStatus(); client.close(); clientRef.current = null; };
  }, [role]);

  const send = useCallback((command: LiveCommand) => clientRef.current?.send(command) ?? false, []);
  const sendAudio = useCallback((pcm: ArrayBuffer | Uint8Array, sampleRate?: number, track?: AudioTrack, channels?: number) => clientRef.current?.sendAudio(pcm, sampleRate, track, channels) ?? false, []);
  return { snapshot, products, status, connected, send, sendAudio };
}

function pcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) pcm[index] = Math.max(-1, Math.min(1, samples[index])) * 0x7fff;
  const bytes = new Uint8Array(pcm.byteLength);
  bytes.set(new Uint8Array(pcm.buffer));
  return bytes;
}

function resample(samples: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return samples.slice();
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const weight = position - left;
    output[index] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

function useMicrophone(sendAudio: (pcm: ArrayBuffer | Uint8Array, sampleRate?: number, track?: AudioTrack, channels?: number) => boolean) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const stopCapture = useCallback(() => {
    processorRef.current?.disconnect();
    contextRef.current?.close().catch(() => undefined);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    processorRef.current = null;
    contextRef.current = null;
    streamRef.current = null;
    setCapturing(false);
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
      setDevices(inputs);
      setDeviceId((current) => current && inputs.some((device) => device.deviceId === current) ? current : inputs[0]?.deviceId ?? '');
    } catch {
      // Device enumeration may be blocked until microphone permission is granted.
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return () => stopCapture();
    mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => { mediaDevices.removeEventListener('devicechange', refreshDevices); stopCapture(); };
  }, [refreshDevices, stopCapture]);

  const start = useCallback(async (requestedDeviceId = deviceId): Promise<boolean> => {
    setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风收音');
      stopCapture();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...(requestedDeviceId ? { deviceId: { exact: requestedDeviceId } } : {}),
      } });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        const sourceRate = event.inputBuffer.sampleRate || context.sampleRate;
        sendAudio(pcm16(samples), sourceRate, 'source', 1);
        sendAudio(pcm16(resample(samples, sourceRate, 16_000)), 16_000, 'asr', 1);
      };
      source.connect(processor);
      processor.connect(context.destination);
      streamRef.current = stream;
      contextRef.current = context;
      processorRef.current = processor;
      setCapturing(true);
      const activeDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId;
      if (activeDeviceId) setDeviceId(activeDeviceId);
      void refreshDevices();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法使用麦克风');
      stopCapture();
      return false;
    }
  }, [deviceId, refreshDevices, sendAudio, stopCapture]);

  const selectDevice = useCallback(async (nextDeviceId: string): Promise<boolean> => {
    setDeviceId(nextDeviceId);
    if (capturing) return start(nextDeviceId);
    return true;
  }, [capturing, start]);

  return { capturing, error, devices, deviceId, start, stop: stopCapture, refreshDevices, selectDevice };
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function lifecycleText(lifecycle: LiveSessionSnapshot['lifecycle']): string {
  return ({ idle: '待开播', live: '直播中', paused: '已暂停', ending: '正在收尾', ended: '已结束' })[lifecycle];
}

function riskText(risk: ComplianceResult['risk'] | undefined): string {
  return risk === 'blocked' ? '高风险' : risk === 'warning' ? '需注意' : '表达安全';
}

function SpeakerBadge({ segment }: { segment: TranscriptSegment }) {
  const automatic = segment.speakerSource === 'automatic';
  return <span className={`v2-speaker ${segment.speaker === 'other' ? 'other' : 'host'} ${automatic ? 'automatic' : ''}`}>
    {segment.speaker === 'other' ? <UsersRound size={11} /> : <UserRound size={11} />}
    {segment.speaker === 'other' ? '其他人' : automatic ? `${segment.speakerId ?? '待确认'}` : '主播'}
  </span>;
}

function TranscriptFeed({ snapshot, compact = false }: { snapshot: LiveSessionSnapshot; compact?: boolean }) {
  const items = snapshot.transcriptHistory.slice(compact ? -4 : -8);
  return <section className={`v2-transcript ${compact ? 'compact' : ''}`}>
    <header><div><span>实时转录</span><strong>{snapshot.partialTranscript ? '识别中' : '已同步'}</strong></div><small>共 {snapshot.transcriptHistory.length} 段</small></header>
    {snapshot.partialTranscript && <div className="v2-partial"><span>···</span><p>{snapshot.partialTranscript}</p></div>}
    <div className="v2-transcript-list">
      {items.map((segment) => <article key={segment.id}><time>{formatTime(segment.timestamp)}</time><SpeakerBadge segment={segment} /><p>{segment.text}</p></article>)}
      {!items.length && !snapshot.partialTranscript && <div className="v2-empty">开始收音后，识别结果会出现在这里</div>}
    </div>
  </section>;
}

function CoachBoard({ snapshot, display = false }: { snapshot: LiveSessionSnapshot; display?: boolean }) {
  const suggestions = snapshot.coachSuggestions.length ? snapshot.coachSuggestions : [
    { id: 'empty-1', purpose: '塑品' as const, text: `可以先介绍${snapshot.product.name}的核心使用场景。`, reason: '建立商品价值', source: 'local-fallback' as const, createdAt: Date.now() },
    { id: 'empty-2', purpose: '互动' as const, text: '问问大家最想了解哪个细节，再按页面信息逐项说明。', reason: '引导评论互动', source: 'local-fallback' as const, createdAt: Date.now() },
    { id: 'empty-3', purpose: '转化' as const, text: '需要的朋友可以打开商品卡，确认规格和实时价格。', reason: '承接下单动作', source: 'local-fallback' as const, createdAt: Date.now() },
  ];
  return <section className={`v2-coach-board ${display ? 'display' : ''}`}>
    <header><div><Sparkles size={16} /><span>主播下一句</span></div><small>{snapshot.coachPending ? '正在结合本场状态优化' : '三段备选话术'}</small></header>
    <div className="v2-coach-grid">{suggestions.slice(0, 3).map((suggestion, index) => <article key={suggestion.id}><div><b>{index + 1}</b><strong>{suggestion.purpose}</strong></div><p>{suggestion.text}</p><small>{suggestion.reason}</small></article>)}</div>
  </section>;
}

function RiskPanel({ snapshot, display = false }: { snapshot: LiveSessionSnapshot; display?: boolean }) {
  const result = snapshot.latestCompliance;
  const risk = result?.risk ?? 'safe';
  return <section className={`v2-risk-panel ${risk} ${display ? 'display' : ''}`}>
    <header><div>{risk === 'safe' ? <CheckCircle2 size={17} /> : <ShieldAlert size={17} />}<strong>{riskText(risk)}</strong></div>{typeof result?.analysisMs === 'number' && <span>{result.analysisMs}ms</span>}</header>
    <h3>{result?.title ?? '当前没有风险提醒'}</h3>
    <p>{result?.reason ?? '本地规则会持续检查主播表达，模型判断完成后会在这里更新。'}</p>
    {result && risk !== 'safe' && <div className="v2-risk-advice"><span>建议替换</span><strong>{result.alternative.replace(/^可以改为：/u, '')}</strong></div>}
    {!display && <div className="v2-alert-log"><span>近期提醒</span>{snapshot.alerts.slice(0, 4).map((alert) => <div key={alert.id}><i className={alert.risk} /><p>{alert.title}</p><time>{formatTime(alert.createdAt)}</time></div>)}</div>}
  </section>;
}

function ProductRail({ snapshot, products, send, openHistory, openLibrary }: { snapshot: LiveSessionSnapshot; products: Product[]; send: (command: LiveCommand) => boolean; openHistory: () => void; openLibrary: () => void }) {
  return <aside className="v2-left-rail">
    <section><header><Package size={15} /><span>本场商品</span></header><div className="v2-product-list">{products.map((product) => <button type="button" className={snapshot.product.id === product.id ? 'active' : ''} key={product.id} onClick={() => send({ type: 'select_product', productId: product.id })}><img src={product.image} alt="" /><span><strong>{product.name}</strong><small>{product.category} · {product.price}</small></span></button>)}</div></section>
    <section className="v2-risk-profile"><header><ShieldAlert size={15} /><span>风控等级</span></header><div>{(['strict', 'balanced', 'optimized'] as const).map((profile) => <button type="button" className={snapshot.riskProfile === profile ? 'active' : ''} key={profile} onClick={() => send({ type: 'set_risk_profile', profile })}>{profile === 'strict' ? '严格' : profile === 'balanced' ? '均衡' : '优化'}</button>)}</div></section>
    <button type="button" className="v2-history-button" onClick={openLibrary}><BookOpen size={15} />资料管理</button>
    <button type="button" className="v2-history-button secondary" onClick={openHistory}><History size={15} />历史复核</button>
  </aside>;
}

function LiveControls({ snapshot, connected, status, send, sendAudio }: { snapshot: LiveSessionSnapshot; connected: boolean; status: string; send: (command: LiveCommand) => boolean; sendAudio: (pcm: ArrayBuffer | Uint8Array, sampleRate?: number, track?: AudioTrack, channels?: number) => boolean }) {
  const microphone = useMicrophone(sendAudio);
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const selectedDevice = microphone.devices.find((device) => device.deviceId === microphone.deviceId);
  const begin = async () => {
    if (!await microphone.start()) return;
    setDevicePickerOpen(false);
    send({ type: snapshot.lifecycle === 'paused' ? 'resume' : 'start' });
  };
  const changeDevice = async (nextDeviceId: string) => { if (!await microphone.selectDevice(nextDeviceId) && snapshot.lifecycle === 'live') send({ type: 'pause' }); };
  const pause = () => { microphone.stop(); send({ type: 'pause' }); };
  const end = () => { microphone.stop(); send({ type: 'end' }); };
  return <div className="v2-live-controls">
    <div className={`v2-connection ${connected ? 'online' : ''}`}><i />{status}</div>
    <div className="v2-device-picker">
      <button type="button" className="device" aria-label={`选择输入设备${selectedDevice?.label ? `，当前 ${selectedDevice.label}` : ''}`} aria-expanded={devicePickerOpen} onClick={() => { setDevicePickerOpen((open) => !open); void microphone.refreshDevices(); }}><Mic size={14} /><span><strong>选择输入设备</strong><small>{selectedDevice?.label || (microphone.deviceId ? '已选择麦克风' : '系统默认麦克风')}</small></span><ChevronDown size={13} /></button>
      {devicePickerOpen && <div className="v2-device-menu"><label htmlFor="v2-audio-input">收音设备</label><select id="v2-audio-input" value={microphone.deviceId} onChange={(event) => void changeDevice(event.target.value)}><option value="">系统默认麦克风</option>{microphone.devices.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}</select><button type="button" onClick={() => void microphone.refreshDevices()}><RefreshCw size={12} />刷新设备</button></div>}
    </div>
    {(snapshot.lifecycle === 'idle' || snapshot.lifecycle === 'paused') && <button type="button" className="primary" onClick={() => void begin()} disabled={!connected}><Mic size={15} />{snapshot.lifecycle === 'paused' ? '继续录制' : '开启直播录制'}</button>}
    {snapshot.lifecycle === 'live' && <button type="button" onClick={pause}><Pause size={15} />暂停录制</button>}
    {snapshot.lifecycle !== 'idle' && snapshot.lifecycle !== 'ended' && <button type="button" className="danger" onClick={end} disabled={snapshot.lifecycle === 'ending'}><CircleStop size={15} />{snapshot.lifecycle === 'ending' ? '正在结束' : '结束本场'}</button>}
    {microphone.error && <span className="v2-control-error">{microphone.error}</span>}
  </div>;
}

function DemoInput({ snapshot, send }: { snapshot: LiveSessionSnapshot; send: (command: LiveCommand) => boolean }) {
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); if (!text.trim()) return; send({ type: 'demo_transcript', text: text.trim() }); setText(''); };
  const examples = snapshot.product.compliantPhrases.slice(0, 2);
  return <section className="v2-demo"><span>对应商品参考话术</span><div>{examples.map((example) => <button type="button" key={example} onClick={() => send({ type: 'demo_transcript', text: example })}>{example}</button>)}</div><form onSubmit={submit}><input value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴或输入主播话术进行核验" /><button type="submit" title="提交"><Send size={14} /></button></form></section>;
}

function DisplayLinkPanel({ sessionId }: { sessionId: string }) {
  const client = useMemo(() => new DisplayLinkClient(), []);
  const [expanded, setExpanded] = useState(false);
  const [link, setLink] = useState<DisplayLink | null>(null);
  const [qrCode, setQrCode] = useState('');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const linkUrl = link ? new URL(link.path, window.location.origin).toString() : '';

  useEffect(() => {
    if (!expanded || !sessionId || link?.sessionId === sessionId) return;
    let active = true;
    setMessage('正在生成入口');
    setLink(null);
    setQrCode('');
    void client.create(sessionId).then(async (next) => {
      const url = new URL(next.path, window.location.origin).toString();
      const svg = await QRCode.toString(url, { type: 'svg', width: 220, margin: 1, color: { dark: '#172018', light: '#ffffff' } });
      if (!active) return;
      setLink(next);
      setQrCode(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      setMessage('');
    }).catch((error) => { if (active) setMessage(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [client, expanded, link?.sessionId, sessionId]);

  const copyLink = async () => {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch { setMessage('复制失败，请直接打开主播屏'); }
  };

  return <details className="v2-display-link" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><ChevronDown size={13} />主播屏入口</summary>
    {expanded && <div className="v2-display-link-body">
      {message && <span className="v2-display-link-message">{message}</span>}
      {link && <>
        <div className="v2-display-link-heading"><QrCode size={17} /><div><strong>临时入口 {link.alias}</strong><small>{new Date(link.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 前有效</small></div></div>
        {qrCode && <img src={qrCode} alt="主播屏二维码" />}
        <code>{linkUrl}</code>
        <div className="v2-display-link-actions">
          <button type="button" title="复制主播屏地址" onClick={() => void copyLink()}><Copy size={14} /><span>{copied ? '已复制' : '复制'}</span></button>
          <a href={linkUrl} target="_blank" rel="noreferrer" title="在新窗口打开主播屏"><ExternalLink size={14} /><span>打开</span></a>
        </div>
      </>}
    </div>}
  </details>;
}

function blankProduct(): Product {
  return {
    id: `product-${Date.now().toString(36)}`,
    name: '',
    category: '其他',
    price: '¥0',
    stock: null,
    sku: `SKU-${Date.now().toString(36).toUpperCase()}`,
    description: '',
    sellingPoints: [],
    image: '/products/serum.svg',
    accent: '#8da57d',
    compliantPhrases: [],
    source: 'manual',
    updatedAt: Date.now(),
  };
}

function ProductCatalogEditor({ roomId, activeProductId, products }: { roomId: string; activeProductId: string; products: Product[] }) {
  const client = useMemo(() => new CatalogClient(), []);
  const [items, setItems] = useState(products);
  const [draft, setDraft] = useState<Product | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setItems(await client.products(roomId)); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [client, roomId]);
  useEffect(() => { setItems(products); }, [products]);
  useEffect(() => { void load(); }, [load]);

  const updateDraft = <K extends keyof Product>(key: K, value: Product[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true); setMessage('');
    try {
      const saved = await client.saveProduct(roomId, { ...draft, updatedAt: Date.now() });
      setItems((current) => current.some((product) => product.id === saved.id) ? current.map((product) => product.id === saved.id ? saved : product) : [...current, saved]);
      setDraft(null);
      setMessage('商品资料已同步到当前直播间和本场页面');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const remove = async (product: Product) => {
    if (typeof window.confirm === 'function' && !window.confirm(`确定从当前直播间移除“${product.name}”吗？`)) return;
    setBusy(true); setMessage('');
    try { setItems(await client.removeProduct(roomId, product.id)); if (draft?.id === product.id) setDraft(null); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };

  return <div className="v2-product-manager">
    <section className="v2-product-catalog">
      <header><div><strong>当前直播间商品</strong><small>{items.length} 个 · 修改后实时同步本场</small></div><button type="button" className="v2-add-product" onClick={() => setDraft(blankProduct())}><Plus size={13} />新增商品</button></header>
      <div>{items.map((product) => <article className={product.id === activeProductId ? 'active' : ''} key={product.id}><img src={product.image} alt="" /><div><strong>{product.name}</strong><small>{product.category} · {product.price} · {product.sku}</small><p>{product.description}</p></div><div className="v2-product-actions"><button type="button" aria-label={`编辑 ${product.name}`} onClick={() => setDraft(structuredClone(product))}><Pencil size={13} /></button><button type="button" aria-label={`移除 ${product.name}`} disabled={busy || items.length <= 1} onClick={() => void remove(product)}><Trash2 size={13} /></button></div></article>)}</div>
    </section>
    <section className="v2-product-editor-panel">
      {draft ? <form onSubmit={(event) => void save(event)}>
        <header><div><strong>{items.some((product) => product.id === draft.id) ? '编辑商品资料' : '新增直播间商品'}</strong><small>{draft.id}</small></div><button type="button" aria-label="关闭商品编辑" onClick={() => setDraft(null)}><X size={14} /></button></header>
        <div className="v2-product-fields"><label>商品名称<input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} required /></label><label>商品分类<input value={draft.category} onChange={(event) => updateDraft('category', event.target.value)} required /></label><label>实时价格<input value={draft.price} onChange={(event) => updateDraft('price', event.target.value)} required /></label><label>商品编码<input value={draft.sku} onChange={(event) => updateDraft('sku', event.target.value)} required /></label></div>
        <label>商品描述<textarea value={draft.description} onChange={(event) => updateDraft('description', event.target.value)} placeholder="可稍后补充" /></label>
        <label>核心卖点<textarea value={draft.sellingPoints.join('\n')} onChange={(event) => updateDraft('sellingPoints', event.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} placeholder="每行一个卖点，可稍后补充" /></label>
        <label>对应商品参考话术<textarea value={draft.compliantPhrases.join('\n')} onChange={(event) => updateDraft('compliantPhrases', event.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} placeholder="每行一段，可稍后补充" /></label>
        <button type="submit" disabled={busy || !draft.name.trim() || !draft.category.trim() || !draft.price.trim() || !draft.sku.trim()}><Save size={13} />保存并同步本场</button>
      </form> : <div className="v2-product-editor-empty"><Package size={24} /><strong>选择商品开始调整</strong><span>开播中修改会同步到中控台、主播屏和本场历史</span></div>}
    </section>
    {message && <div className="v2-product-message">{message}</div>}
  </div>;
}

function LibraryWorkspace({ snapshot, products, send, onClose }: { snapshot: LiveSessionSnapshot; products: Product[]; send: (command: LiveCommand) => boolean; onClose: () => void }) {
  const client = useMemo(() => new CatalogClient(), []);
  const [tab, setTab] = useState<'products' | 'rules' | 'phrases'>('phrases');
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [presenters, setPresenters] = useState<PresenterProfile[]>([]);
  const [presenterId, setPresenterId] = useState(snapshot.presenterId);
  const [phrases, setPhrases] = useState<PresenterPhrase[]>([]);
  const [ruleDraft, setRuleDraft] = useState({ pattern: '', title: '', alternative: '' });
  const [phraseDraft, setPhraseDraft] = useState('');
  const [purpose, setPurpose] = useState<CoachPurpose>('塑品');
  const [newPresenter, setNewPresenter] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ruleData, presenterData] = await Promise.all([client.rules(snapshot.roomId), client.presenters(snapshot.roomId)]);
      setRules(ruleData.rules); setPresenters(presenterData);
      const selected = presenterData.some((presenter) => presenter.id === presenterId) ? presenterId : presenterData[0]?.id ?? '';
      setPresenterId(selected);
      setPhrases(selected ? await client.phrases(selected) : []);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [client, presenterId, snapshot.roomId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (presenterId) void client.phrases(presenterId).then(setPhrases).catch(() => undefined); }, [client, presenterId]);
  const run = async (task: () => Promise<unknown>) => { setBusy(true); setMessage(''); try { await task(); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const addRule = () => run(async () => { await client.createRule(snapshot.roomId, { name: ruleDraft.title || ruleDraft.pattern, pattern: ruleDraft.pattern, risk: 'blocked', title: ruleDraft.title, reason: '命中当前直播间确认的高风险表达', alternative: ruleDraft.alternative, policyRef: '直播间自定义规则' }); setRuleDraft({ pattern: '', title: '', alternative: '' }); });
  const addPhrase = () => run(async () => { await client.createPhrase(presenterId, { text: phraseDraft, productId: snapshot.product.id, purpose, status: 'draft' }); setPhraseDraft(''); });
  const addPresenter = () => run(async () => { const presenter = await client.createPresenter(snapshot.roomId, newPresenter); setNewPresenter(''); setPresenterId(presenter.id); });

  return <div className="v2-modal"><section className="v2-review-workspace v2-library-workspace">
    <header><div><BookOpen size={19} /><span><strong>资料管理</strong><small>商品、风险规则与主播专属话术均保存在本机</small></span></div><button type="button" title="关闭" onClick={onClose}><X size={17} /></button></header>
    <nav>{(['phrases', 'rules', 'products'] as const).map((item) => <button type="button" key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item === 'phrases' ? '主播话术' : item === 'rules' ? '风险规则' : '商品资料'}</button>)}</nav>
    <main>{tab === 'products' && <ProductCatalogEditor roomId={snapshot.roomId} activeProductId={snapshot.product.id} products={products} />}
      {tab === 'rules' && <div className="v2-library-columns"><section><header><span>新增高置信规则</span></header><input value={ruleDraft.pattern} onChange={(event) => setRuleDraft({ ...ruleDraft, pattern: event.target.value })} placeholder="风险词或明确短语" /><input value={ruleDraft.title} onChange={(event) => setRuleDraft({ ...ruleDraft, title: event.target.value })} placeholder="提醒标题" /><textarea value={ruleDraft.alternative} onChange={(event) => setRuleDraft({ ...ruleDraft, alternative: event.target.value })} placeholder="主播可直接替换的安全表达" /><button type="button" disabled={busy || !ruleDraft.pattern || !ruleDraft.title || !ruleDraft.alternative} onClick={addRule}><Plus size={13} />保存规则</button></section><section className="v2-library-list">{rules.map((rule) => <article key={rule.id}><div><span className={rule.risk}>{rule.risk === 'blocked' ? '高风险' : '提醒'}</span><strong>{rule.name}</strong></div><p>{rule.pattern}</p><small>{rule.origin === 'learned' ? `自动沉淀 · 证据 ${rule.evidenceCount ?? 1} 次` : `人工规则 · v${rule.version}`}</small><button type="button" onClick={() => void run(() => client.setRuleEnabled(rule, !rule.enabled))}>{rule.enabled ? '停用' : '启用'}</button></article>)}</section></div>}
      {tab === 'phrases' && <div className="v2-library-columns"><section><header><span>主播档案</span></header><select value={presenterId} onChange={(event) => setPresenterId(event.target.value)}>{presenters.map((presenter) => <option value={presenter.id} key={presenter.id}>{presenter.name}</option>)}</select><button type="button" disabled={!presenterId || presenterId === snapshot.presenterId} onClick={() => send({ type: 'select_presenter', presenterId })}><UserRound size={13} />{presenterId === snapshot.presenterId ? '本场当前主播' : '设为本场主播'}</button><div className="v2-inline-form"><input value={newPresenter} onChange={(event) => setNewPresenter(event.target.value)} placeholder="新增主播名称" /><button type="button" disabled={!newPresenter.trim() || busy} onClick={addPresenter}><Plus size={13} /></button></div><select value={purpose} onChange={(event) => setPurpose(event.target.value as CoachPurpose)}><option>塑品</option><option>憋单</option><option>逼单</option><option>转化</option><option>互动</option><option>留人</option><option>答疑</option></select><textarea value={phraseDraft} onChange={(event) => setPhraseDraft(event.target.value)} placeholder="录入头部直播间话术，或保存下一场参考表达" /><button type="button" disabled={busy || !presenterId || !phraseDraft.trim()} onClick={addPhrase}><Save size={13} />保存话术</button></section><section className="v2-library-list">{phrases.map((phrase) => <article key={phrase.id}><div><span className={phrase.status}>{phrase.status === 'reference' ? '下一场参考' : phrase.source === 'session' ? '下播归档' : '草稿'}</span><strong>{phrase.purpose ?? '通用'}</strong></div><p>{phrase.text}</p><small>{phrase.source === 'session' ? '来自历史直播' : phrase.source === 'manual' ? '人工录入' : '豆包改写'} · v{phrase.version}</small><button type="button" onClick={() => void run(() => client.updatePhrase(phrase.id, { status: phrase.status === 'reference' ? 'draft' : 'reference' }))}>{phrase.status === 'reference' ? '取消参考' : '选为参考'}</button></article>)}</section></div>}
    </main>{message && <div className="v2-review-message">{message}</div>}
  </section></div>;
}

function ReviewWorkspace({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const client = useMemo(() => new SessionReviewClient(), []);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [review, setReview] = useState<SessionReview | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<{ segmentId: string; text: string } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const items = await client.listSessions(roomId);
      setSessions(items);
      setSelected((current) => current || items[0]?.sessionId || '');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [client, roomId]);
  const loadReview = useCallback(async (sessionId: string) => {
    if (!sessionId) { setReview(null); return; }
    try { const next = await client.getReview(sessionId); setReview(next); setNote(next.summary.note); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [client]);
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => { void loadReview(selected); }, [loadReview, selected]);

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true); setMessage('');
    try { await task(); await loadSessions(); await loadReview(selected); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const saveTranscript = () => editing && run(() => client.correctTranscript(selected, editing.segmentId, editing.text).then(() => setEditing(null)));
  const assignSpeaker = (segment: TranscriptSegment) => run(() => client.assignSpeaker(selected, segment.id, segment.speaker === 'other' ? 'host' : 'other', segment.speakerId));
  const saveNote = () => run(() => client.saveNote(selected, note));
  const deliver = () => run(() => review?.delivery === 'failed' ? client.retryDelivery(selected) : client.approveDelivery(selected));

  return <div className="v2-modal"><section className="v2-review-workspace">
    <header><div><Archive size={19} /><span><strong>历史复核</strong><small>修改后重新人工确认，才会进入知识库和数据库上传队列</small></span></div><button type="button" title="关闭" onClick={onClose}><X size={17} /></button></header>
    <div className="v2-review-layout"><aside><div className="v2-review-sidehead"><span>{sessions.length} 场直播</span><button type="button" title="刷新" onClick={() => void loadSessions()}><RefreshCw size={13} /></button></div>{sessions.map((session) => <button type="button" className={selected === session.sessionId ? 'active' : ''} key={session.sessionId} onClick={() => setSelected(session.sessionId)}><strong>{new Date(session.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong><small>{session.presenterName} · {session.transcriptCount} 段</small><span className={session.delivery}>{session.delivery === 'synced' ? '已上传' : session.approval === 'approved' ? '已确认' : '待确认'}</span></button>)}</aside>
      <main>{review ? <>
        <div className="v2-review-summary"><div><strong>{review.summary.presenterName}</strong><span>内容版本 {review.summary.contentRevision}</span></div><div><span className={`v2-delivery ${review.delivery}`}>{review.delivery === 'synced' ? '已同步' : review.delivery === 'failed' ? '上传失败' : review.approval === 'approved' ? '已人工确认' : '等待人工确认'}</span><button type="button" onClick={deliver} disabled={busy || review.summary.lifecycle !== 'ended' || note !== review.summary.note}><Database size={14} />{review.delivery === 'failed' ? '重新上传' : '确认并上传'}</button></div></div>
        <div className="v2-review-note"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录本场表现、待改话术和下一场安排" /><button type="button" disabled={busy || note === review.summary.note} onClick={saveNote}><Save size={13} />保存备注</button></div>
        {review.audioPath && <SessionAudio client={client} sessionId={selected} />}
        <section className="v2-review-transcripts"><header><span>转录与说话人</span><small>主播 / 其他人可逐段纠正</small></header>{review.transcripts.map((segment) => <article key={segment.id}><time>{formatTime(segment.timestamp)}</time><button type="button" className="v2-speaker-button" onClick={() => void assignSpeaker(segment)} disabled={busy}><SpeakerBadge segment={segment} /></button>{editing?.segmentId === segment.id ? <div className="v2-review-edit"><textarea value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} /><button type="button" onClick={() => void saveTranscript()} disabled={busy}><Save size={13} /></button><button type="button" onClick={() => setEditing(null)}><X size={13} /></button></div> : <><p>{segment.text}</p><button type="button" title="纠正文本" onClick={() => setEditing({ segmentId: segment.id, text: segment.text })}><Pencil size={13} /></button></>}</article>)}</section>
      </> : <div className="v2-empty">选择一场直播开始复核</div>}</main></div>
    {message && <div className="v2-review-message">{message}</div>}
  </section></div>;
}

function SessionAudio({ client, sessionId }: { client: SessionReviewClient; sessionId: string }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setSrc('');
    setError('');
    void client.loadAudioUrl(sessionId).then((url) => {
      objectUrl = url;
      if (active) setSrc(url); else URL.revokeObjectURL(url);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, sessionId]);
  if (error) return <div className="v2-review-message">{error}</div>;
  return src ? <audio controls preload="metadata" src={src} /> : <div className="v2-empty">正在读取本地音频</div>;
}

function OperatorApp() {
  const live = useLive('operator');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  return <div className="v2-app">
    <header className="v2-topbar"><div className="v2-brand"><span><MonitorUp size={18} /></span><div><strong>直播中控</strong><small>风险预警与主播提词</small></div></div><div className="v2-live-state"><i className={live.snapshot.lifecycle === 'live' ? 'live' : ''} /><span>{lifecycleText(live.snapshot.lifecycle)}</span><small>{live.snapshot.presenterName}</small></div><LiveControls snapshot={live.snapshot} connected={live.connected} status={live.status} send={live.send} sendAudio={live.sendAudio} /></header>
    <div className="v2-operator-grid"><ProductRail snapshot={live.snapshot} products={live.products} send={live.send} openHistory={() => setHistoryOpen(true)} openLibrary={() => setLibraryOpen(true)} />
      <main className="v2-main"><header className="v2-product-context"><div><span>当前商品</span><h1>{live.snapshot.product.name}</h1></div><strong>{live.snapshot.product.price}</strong></header><CoachBoard snapshot={live.snapshot} /><TranscriptFeed snapshot={live.snapshot} compact /><DemoInput snapshot={live.snapshot} send={live.send} /></main>
      <aside className="v2-right-rail"><RiskPanel snapshot={live.snapshot} /><section className="v2-session-stats"><div><Clock3 size={14} /><span>直播时长</span><strong>{Math.floor(live.snapshot.stats.speakingSeconds / 60).toString().padStart(2, '0')}:{(live.snapshot.stats.speakingSeconds % 60).toString().padStart(2, '0')}</strong></div><div><AlertTriangle size={14} /><span>风险提醒</span><strong>{live.snapshot.stats.warningCount + live.snapshot.stats.blockedCount}</strong></div></section><DisplayLinkPanel sessionId={live.snapshot.sessionId} /></aside>
    </div>{historyOpen && <ReviewWorkspace roomId={live.snapshot.roomId} onClose={() => setHistoryOpen(false)} />}{libraryOpen && <LibraryWorkspace snapshot={live.snapshot} products={live.products} send={live.send} onClose={() => setLibraryOpen(false)} />}
  </div>;
}

function DisplayApp() {
  const live = useLive('display');
  const currentTranscript = live.snapshot.partialTranscript || live.snapshot.transcriptHistory.at(-1)?.text || '等待主播开始说话';
  return <div className="v2-display"><header><div className="v2-brand"><span><MonitorUp size={18} /></span><div><strong>主播提示屏</strong><small>{live.snapshot.product.name}</small></div></div><div className="v2-live-state"><i className={live.snapshot.lifecycle === 'live' ? 'live' : ''} /><span>{lifecycleText(live.snapshot.lifecycle)}</span></div></header><main><section className="v2-display-transcript"><header><span>流式话术转录</span><SpeakerBadge segment={live.snapshot.transcriptHistory.at(-1) ?? { id: 'partial', text: '', isFinal: false, timestamp: Date.now(), offsetMs: null, startOffsetMs: null, endOffsetMs: null, speaker: 'host' }} /></header><p>{currentTranscript}</p></section><CoachBoard snapshot={live.snapshot} display /><RiskPanel snapshot={live.snapshot} display /></main><footer><span>{live.status}</span><strong>{live.snapshot.product.name} · {live.snapshot.product.price}</strong></footer></div>;
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const client = useMemo(() => new AuthClient(), []);
  const [actorId, setActorId] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage('');
    try { await client.login(actorId, password); onLoggedIn(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  return <main className="v2-login"><form onSubmit={(event) => void submit(event)}><div className="v2-brand"><span><MonitorUp size={20} /></span><div><strong>直播中控</strong><small>多人协作模式</small></div></div><h1>登录直播中控</h1><label>账号<input autoFocus autoComplete="username" value={actorId} onChange={(event) => setActorId(event.target.value)} /></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{message && <p>{message}</p>}<button className="primary" type="submit" disabled={busy || !actorId.trim() || !password}>{busy ? '正在登录' : '登录'}</button></form></main>;
}

function OperatorGate() {
  const [loginRequired, setLoginRequired] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const requireLogin = () => setLoginRequired(true);
    window.addEventListener(V2_AUTH_REQUIRED_EVENT, requireLogin);
    return () => window.removeEventListener(V2_AUTH_REQUIRED_EVENT, requireLogin);
  }, []);
  if (loginRequired) return <LoginScreen onLoggedIn={() => { setLoginRequired(false); setGeneration((value) => value + 1); }} />;
  return <OperatorApp key={generation} />;
}

export default function App() {
  return window.location.pathname.startsWith('/screen/') ? <DisplayApp /> : <OperatorGate />;
}
