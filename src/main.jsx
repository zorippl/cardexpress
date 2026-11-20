import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './photos.css';
import './workspace.css';
import './theme.css';
import { version, author } from '../package.json';
import { selectionRanges } from './selection.mjs';
import { thumbnailQueue } from './thumbnail-queue.mjs';

const api = window.cardExpress;
const bytes = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB`
  : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`;
const dateLabel = value => value === 'unknown' ? '日期未识别' : value.replaceAll('-', '.');
const formats = { raw: 'RAW', jpg: 'JPG' };
const photoSizes = [82, 102, 128, 160, 200];
const queueThumbnail = thumbnailQueue(id => api.preview(id, 'thumb'));
const filenameOrder = new Intl.Collator(undefined, { numeric: true });
const noFiles = [];
const captureLabel = file => file.date ? `${file.date}${file.time ? ` ${file.time}` : ' · 时间未知'}` : '日期未识别';
const latestDate = files => files.reduce((latest, file) => file.date && (!latest || file.date > latest) ? file.date : latest, null);

function Icon({ name, size = 20 }) {
  const paths = {
    card: <><rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 3v5m3-5v5m3-5v5M9 15h6"/></>,
    folder: <path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3V8Z"/>,
    arrow: <><path d="M4 12h15m-6-6 6 6-6 6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/></>,
    refresh: <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.folder}</svg>;
}

function PhotoCheckbox({ file, checked, disabled, onToggle }) {
  return <input className="photo-checkbox" type="checkbox" aria-label={`选择 ${file.name}`} title="按住 Shift 点击可选择或取消连续范围"
    checked={checked} disabled={disabled || !file.date} onChange={event => onToggle(file.id, event.target.checked, event.nativeEvent.shiftKey)}/>;
}

const PhotoTile = memo(function PhotoTile({ file, number, checked, disabled, onOpen, onToggle, registerThumbnail }) {
  const [image, setImage] = useState(undefined);
  const tile = useRef(null);
  useEffect(() => registerThumbnail(tile.current, file.id, setImage), [file.id, registerThumbnail]);
  return <div ref={tile} className={`photo-card${checked ? ' picked' : ''}`}>
    <button className="photo-tile" onClick={() => onOpen(file.id)} title={`#${number} · ${file.name} · ${captureLabel(file)}`}>
      <span className="photo-frame">{image ? <img src={image} alt="" decoding="async" onError={() => setImage(null)}/>
        : <span className="photo-placeholder"><Icon name="image" size={22}/>{image === null ? '无缩略图' : '加载中'}</span>}</span>
      <span className="photo-caption"><strong>{file.name}</strong><small>#{number}{file.time ? ` · ${file.time}` : ''}</small></span>
    </button>
    <PhotoCheckbox {...{ file, checked, disabled, onToggle }}/>
  </div>;
});

const PhotoGrid = memo(function PhotoGrid({ files, size, selected, disabled, onOpen, onToggle }) {
  const grid = useRef(null);
  const listeners = useRef(new Map());
  const observation = useRef(null);
  const registerThumbnail = useCallback((node, id, callback) => {
    listeners.current.set(node, { id, callback });
    observation.current?.observer.observe(node);
    return () => {
      listeners.current.delete(node);
      observation.current?.observer.unobserve(node);
      const jobs = observation.current?.jobs;
      jobs?.get(node)?.();
      jobs?.delete(node);
    };
  }, []);
  useEffect(() => {
    if (!api) return;
    const element = grid.current;
    const jobs = new Map();
    let live = true;
    const observer = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (!isIntersecting && jobs.get(target)?.()) jobs.delete(target);
      }
      for (const { target, isIntersecting } of entries) {
        const listener = listeners.current.get(target);
        if (isIntersecting && listener && !jobs.has(target)) {
          jobs.set(target, queueThumbnail(listener.id, image => {
            if (!live || listeners.current.get(target) !== listener) return;
            jobs.delete(target);
            observer.unobserve(target);
            listener.callback(image);
          }));
        }
      }
    }, { root: element.parentElement });
    observation.current = { observer, jobs };
    for (const tile of listeners.current.keys()) observer.observe(tile);
    return () => {
      live = false;
      observation.current = null;
      observer.disconnect();
      for (const cancel of jobs.values()) cancel();
    };
  }, []);
  return <div ref={grid} className="photo-grid" style={{ '--tile-size': `${size}px` }}>
    {files.map((file, i) => <PhotoTile key={file.id} file={file} number={i + 1} registerThumbnail={registerThumbnail}
      checked={selected.has(file.id)} {...{ disabled, onOpen, onToggle }}/>)}
  </div>;
});

function PreviewDialog({ file, index, total, onMove, onClose, checked, disabled, onToggle }) {
  const dialog = useRef(null);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    let live = true;
    api.preview(file.id, 'full').then(src => { if (live) setPreview({ id: file.id, src }); })
      .catch(() => { if (live) setPreview({ id: file.id, src: null, error: true }); });
    return () => { live = false; };
  }, [file.id]);
  const current = preview?.id === file.id ? preview : null;
  return <dialog ref={dialog} className="photo-dialog" aria-labelledby="photo-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialog.current) onClose(); }}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); onMove(event.key === 'ArrowLeft' ? -1 : 1);
      }
    }}>
    <div className="photo-dialog-inner">
      <header><div><h2 id="photo-title">{file.name}</h2><small>{[captureLabel(file), file.camera, bytes(file.size)].filter(Boolean).join(' · ')}</small></div>
        <button className="secondary" onClick={onClose} autoFocus>关闭 <span aria-hidden="true">×</span></button></header>
      <div className="photo-stage" aria-busy={!current}>
        {current?.src ? <img src={current.src} alt={file.name} onError={() => setPreview({ id: file.id, src: null, error: true })}/>
          : <div className="photo-placeholder" role="status"><Icon name="image" size={40}/>{!current ? '正在加载照片预览…' : current.error ? '无法读取预览，请检查存储卡连接' : '无法生成预览，仍可归档有拍摄日期的原片'}</div>}
      </div>
      <footer><button className="secondary" disabled={index === 0} onClick={() => onMove(-1)}>← 上一张</button>
        <label className="preview-pick"><PhotoCheckbox {...{ file, checked, disabled, onToggle }}/>{index + 1} / {total} · 选入归档</label>
        <button className="secondary" disabled={index === total - 1} onClick={() => onMove(1)}>下一张 →</button></footer>
    </div>
  </dialog>;
}

function App() {
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState('new');
  const [format, setFormat] = useState('raw');
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [active, setActive] = useState(null);
  const [fields, setFields] = useState({ location: '', theme: '', model: '' });
  const [busy, setBusy] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lostPaths, setLostPaths] = useState({});
  const [result, setResult] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [previewId, setPreviewId] = useState(null);
  const [viewMode, setViewMode] = useState('grid');
  const [zoom, setZoom] = useState(2);
  const [range, setRange] = useState('');
  const [rangeError, setRangeError] = useState('');
  const anchor = useRef(null);
  const scanSequence = useRef(0);
  const activeScan = useRef(null);

  useEffect(() => api?.onProgress(setProgress), []);
  useEffect(() => api?.onScanFiles?.(({ scanId, files: batch }) => {
    if (scanId !== activeScan.current) return;
    setFiles(previous => previous.concat(batch));
    const firstDate = latestDate(batch);
    if (firstDate) setActive(previous => previous ?? firstDate);
  }), []);
  useEffect(() => api?.onLocationLost(({ kind, path }) => {
    setLostPaths(previous => ({ ...previous, [kind]: path }));
    setConfirm(false);
    if (kind === 'source') {
      activeScan.current = null;
      setSource(''); setFiles([]); setSelected(new Set()); setActive(null);
      setScanned(false); setPreviewId(null); setNotice('');
      resetRange();
    } else {
      setTarget('');
    }
  }), []);
  const groups = useMemo(() => {
    const grouped = new Map();
    for (const file of files) {
      const key = file.date || 'unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(file);
    }
    for (const list of grouped.values()) list.sort((a, b) => (a.time || '99').localeCompare(b.time || '99') ||
      filenameOrder.compare(a.relativePath, b.relativePath));
    return [...grouped.entries()].sort(([a], [b]) => a === 'unknown' ? 1 : b === 'unknown' ? -1 : b.localeCompare(a))
      .map(([date, list]) => [date, list, list.reduce((sum, file) => sum + file.size, 0)]);
  }, [files]);
  const visible = groups.find(([key]) => key === active)?.[1] || noFiles;
  const photoIndices = useMemo(() => new Map(visible.map((file, i) => [file.id, i])), [visible]);
  const previewIndex = photoIndices.get(previewId) ?? -1;
  const chosen = useMemo(() => files.filter(file => selected.has(file.id)), [files, selected]);
  const eligible = useMemo(() => files.filter(file => file.date), [files]);
  const chosenCounts = useMemo(() => {
    const counts = new Map();
    for (const file of chosen) counts.set(file.date, (counts.get(file.date) || 0) + 1);
    return counts;
  }, [chosen]);
  const dates = [...chosenCounts.keys()].sort().reverse();
  const dayCount = chosenCounts.get(active) || 0;
  const canSelectDay = !busy && !!active && active !== 'unknown';
  const totalSize = chosen.reduce((sum, file) => sum + file.size, 0);
  const validFields = Object.values(fields).every(value => value.trim() && value.trim().length <= 60 &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(value.trim()) && !/[. ]$/.test(value.trim()));
  const reuse = mode === 'reuse';
  const formatLabel = formats[format];
  const ready = api && !busy && target && chosen.length > 0 && (reuse || validFields);
  const preview = `${(dates[0] || '2026-05-04').replaceAll('-', '')}_${fields.location.trim() || '地点'}_${fields.theme.trim() || '主题'}_${fields.model.trim() || '模特'}`;
  const percent = progress?.total ? Math.round(progress.done / progress.total * 100) : 0;

  async function pick(kind) {
    try {
      setError('');
      const value = await api.chooseFolder(kind);
      if (!value) return;
      setLostPaths(previous => ({ ...previous, [kind === 'source' ? 'source' : 'target']: null }));
      if (kind === 'source') {
        setSource(value);
        await runScan();
      } else setTarget(value);
    } catch (err) { setError(err.message); }
  }

  async function runScan(nextFormat = format) {
    const scanId = ++scanSequence.current;
    activeScan.current = scanId;
    setBusy('scan'); setError(''); setResult(null); setNotice(''); setProgress(null);
    setStopping(false); setConfirm(false); setPreviewId(null); setFiles([]); setSelected(new Set()); setActive(null); setScanned(false);
    resetRange();
    try {
      const data = await api.scan(nextFormat, scanId);
      if (!data || activeScan.current !== scanId) return;
      activeScan.current = null;
      setFiles(data.files);
      setActive(previous => previous ?? latestDate(data.files) ?? (data.files.length ? 'unknown' : null));
      setScanned(true);
      const messages = [];
      if (data.cancelled) messages.push('扫描已停止，当前仅显示已读取的文件；可重新扫描。');
      if (data.warnings.length) messages.push(...data.warnings);
      setNotice(messages.join('\n'));
    } catch (err) {
      if (activeScan.current === scanId) {
        setFiles([]); setActive(null); setPreviewId(null); setError(err.message);
      }
    } finally {
      if (activeScan.current === scanId) activeScan.current = null;
      setBusy(null); setProgress(null); setStopping(false);
    }
  }

  function changeFormat(nextFormat) {
    if (busy || nextFormat === format) return;
    setFormat(nextFormat);
    if (source) void runScan(nextFormat);
  }

  async function startCopy() {
    setConfirm(false); setBusy('copy'); setResult(null); setError(''); setProgress(null);
    setStopping(false);
    try { setResult(await api.copy({ fileIds: [...selected], mode, ...(reuse ? {} : { fields }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(null); setProgress(null); setStopping(false); }
  }

  function resetRange() {
    anchor.current = null;
    setRange(''); setRangeError('');
  }

  const mark = useCallback((list, checked) => {
    setSelected(previous => {
      const next = new Set(previous);
      for (const file of list) if (file.date) checked ? next.add(file.id) : next.delete(file.id);
      return next;
    });
  }, []);

  const togglePhoto = useCallback((id, checked, extend) => {
    if (!canSelectDay) return;
    const index = photoIndices.get(id);
    if (index === undefined) return;
    const start = extend && anchor.current?.date === active ? anchor.current.index : index;
    mark(visible.slice(Math.min(start, index), Math.max(start, index) + 1), checked);
    if (!extend || anchor.current?.date !== active) anchor.current = { date: active, index };
  }, [active, canSelectDay, mark, photoIndices, visible]);

  function applyRange(checked) {
    if (!canSelectDay) return;
    try {
      const ranges = selectionRanges(range, visible.length);
      if (!ranges.length) return;
      // A difference array visits each position once, even with overlapping ranges.
      const changes = new Int32Array(visible.length + 1);
      for (const [start, end] of ranges) { changes[start]++; changes[end]--; }
      let included = 0;
      mark(visible.filter((_, index) => (included += changes[index]) > 0), checked);
      setRangeError('');
    } catch (err) { setRangeError(err.message); }
  }

  return <div className="app">
    <header className="topbar">
      <div className="brand"><img className="brand-icon" src={`${import.meta.env.BASE_URL}cardexpress.svg`} alt=""/><strong>CardExpress</strong><span className="brand-tag">照片归档工作台</span></div>
      <div className="top-meta"><span className="local-status"><span className="status-dot"/> 本地处理 · 照片不上传</span><span className="version">v{version}</span><span className="author" title={`作者：${author.name} · ${author.email}`}><strong>{author.name}</strong><span>{author.email}</span></span></div>
    </header>
    <main>
      {!api && <div className="message warning">当前为浏览器界面预览。请选择桌面应用运行（npm run dev），才能访问存储卡和复制文件。</div>}
      {error && <div className="message error" role="alert">{error}</div>}
      {(lostPaths.source || lostPaths.target) && <div className="message warning" role="alert">
        {lostPaths.source && <div>来源已无法访问：{lostPaths.source}。请重新连接设备，再点「选择存储卡」。</div>}
        {lostPaths.target && <div>归档目标已无法访问：{lostPaths.target}。请重新连接设备，再选择目标文件夹。</div>}
      </div>}
      {notice && <div className="message warning">{notice}</div>}
      <section className="source-bar">
        <div className="source-symbol"><Icon name="card" size={29}/></div>
        <div className="source-info"><span className="eyebrow">01 / 导入来源</span><strong>{source ? source.split(/[/\\]/).filter(Boolean).pop() : '连接你的存储卡'}</strong><span className="path" title={source}>{source || '支持存储卡、读卡器，也可以选择本地照片文件夹'}</span></div>
        {(scanned || files.length > 0) && <span className="scan-count">{files.length} <small>张 {formatLabel}</small></span>}
        {source && <button className="icon-button" title="重新扫描" disabled={!!busy} onClick={() => runScan()}><Icon name="refresh"/></button>}
        <button className="secondary source-picker" disabled={!!busy || !api} onClick={() => pick('source')}><Icon name="folder" size={17}/>{source ? '更换来源' : '选择存储卡'}</button>
      </section>

      <div className="workspace">
        <section className="library panel">
          <div className="panel-heading"><div><span className="eyebrow">02 / 按日期选择</span><h2>拍摄日历 <span>{groups.filter(([key]) => key !== 'unknown').length} 天</span></h2></div>
            <div className="format-switch" role="group" aria-label="图片格式">{Object.entries(formats).map(([value, label]) =>
              <button key={value} type="button" aria-pressed={format === value} disabled={!!busy} onClick={() => changeFormat(value)}>{label} ONLY</button>)}</div>
          </div>
          <div className="library-body">
            <aside className="date-sidebar">
              <div className="date-toolbar"><span>拍摄日期</span><button className="text-button" disabled={!!busy || !eligible.length} onClick={() => mark(eligible, chosen.length !== eligible.length)}>{eligible.length && chosen.length === eligible.length ? '清空全部' : '全选所有日期'}</button></div>
              {groups.length === 0 ? <div className="date-empty">等待导入存储卡</div> : groups.map(([date, list, size]) => {
                const count = chosenCounts.get(date) || 0;
                return <div key={date} className={`date-item ${active === date ? 'active' : ''}`}>
                  <input aria-label={`选择 ${dateLabel(date)} 的全部照片`} type="checkbox" disabled={!!busy || date === 'unknown'} checked={count === list.length}
                    ref={node => { if (node) node.indeterminate = count > 0 && count < list.length; }} onChange={event => mark(list, event.target.checked)}/>
                  <button aria-current={active === date ? 'true' : undefined} onClick={() => { if (active !== date) { setActive(date); resetRange(); } }}><strong>{dateLabel(date)}</strong><span>{count ? `已选 ${count} / ` : ''}{list.length} 张 <i>·</i> {bytes(size)}</span></button>
                  {active === date && <span className="active-marker"/>}
                </div>;
              })}
              <div className="sidebar-tip"><Icon name="shield" size={15}/><span>使用照片内的拍摄时间<br/>不使用文件修改日期</span></div>
            </aside>
            <div className="file-area" aria-label="照片浏览区" tabIndex={active ? 0 : undefined} onKeyDown={event => {
              if (canSelectDay && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' &&
                  !event.target.matches('input:not([type=checkbox]),textarea,[contenteditable]')) {
                event.preventDefault(); mark(visible, !event.shiftKey);
              }
            }}>
              {active ? <>
                <div className="file-heading">
                  <div><h3>{dateLabel(active)}</h3><span>{active === 'unknown' ? '无法识别拍摄日期，暂不参与归档' : busy === 'scan' ? '可预览，扫描完成后可选片' : `已选 ${dayCount} 张`} · {visible.length} 个文件</span></div>
                  <div className="photo-tools">
                    <div className="photo-tool-group" role="group" aria-label="浏览方式">
                      <button className="secondary" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}>缩略图</button>
                      <button className="secondary" aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')}>列表</button>
                    </div>
                    {viewMode === 'grid' && <div className="photo-tool-group" role="group" aria-label="缩略图大小">
                      <button className="secondary" aria-label="缩小缩略图" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)}>−</button>
                      <button className="secondary" aria-label="放大缩略图" disabled={zoom === photoSizes.length - 1} onClick={() => setZoom(zoom + 1)}>＋</button>
                    </div>}
                    <div className="photo-tool-group" role="group" aria-label="当天的照片选择">
                      <button className="secondary" disabled={!canSelectDay || dayCount === visible.length} onClick={() => mark(visible, true)} title="浏览区内 ⌘A / Ctrl+A">当天全选</button>
                      <button className="secondary" disabled={!canSelectDay || !dayCount} onClick={() => mark(visible, false)} title="浏览区内 ⌘Shift+A / Ctrl+Shift+A">清空当天</button>
                    </div>
                  </div>
                </div>
                {active !== 'unknown' && <form className="range-tools" onSubmit={event => { event.preventDefault(); applyRange(true); }}>
                  <label htmlFor="photo-range">按序号</label><input id="photo-range" placeholder="1-10, 15, 20-25" value={range} maxLength={1024} disabled={!canSelectDay}
                    aria-invalid={!!rangeError} aria-describedby={rangeError ? 'photo-range-error' : 'photo-range-hint'} onChange={event => { setRange(event.target.value); setRangeError(''); }}/>
                  <button type="submit" className="secondary" disabled={!canSelectDay || !range.trim()}>选中</button>
                  <button type="button" className="secondary" disabled={!canSelectDay || !range.trim() || !dayCount} onClick={() => applyRange(false)}>取消选中</button>
                  <small id="photo-range-hint">Shift + 点击勾选框可连续选片</small>
                  {rangeError && <small id="photo-range-error" className="range-error" role="alert">{rangeError}</small>}
                </form>}
                <div className="photo-scroll" key={`${format}:${active}:${viewMode}`}>
                  {viewMode === 'grid' ? <PhotoGrid files={visible} size={photoSizes[zoom]}
                    selected={selected} disabled={!canSelectDay} onOpen={setPreviewId} onToggle={togglePhoto}/>
                  : <table className="photo-list"><thead><tr><th scope="col">选</th><th scope="col">#</th><th scope="col">文件名</th><th scope="col">拍摄日期 / 时间</th><th scope="col">大小</th></tr></thead><tbody>
                    {visible.map((file, i) => <tr key={file.id} className={selected.has(file.id) ? 'picked' : undefined}>
                      <td><PhotoCheckbox file={file} checked={selected.has(file.id)} disabled={!canSelectDay} onToggle={togglePhoto}/></td>
                      <td>{i + 1}</td><td><button className="photo-name" title={file.relativePath} onClick={() => setPreviewId(file.id)}>{file.name}</button></td>
                      <td>{captureLabel(file)}</td><td>{bytes(file.size)}</td>
                    </tr>)}
                  </tbody></table>}
                </div>
              </> : <div className="empty-state"><div className="empty-art"><Icon name="image" size={42}/><span>{formatLabel}</span></div><h3>{busy === 'scan' ? '正在读取你的拍摄记录' : scanned ? `没有找到 ${formatLabel} 文件` : '从这里开始整理照片'}</h3><p>{scanned ? '请选择包含此格式的文件夹，或切换图片格式。' : '选择存储卡后，照片会按拍摄日期显示在这里。'}</p>{!source && <button className="text-button" disabled={!api || !!busy} onClick={() => pick('source')}>选择存储卡 <Icon name="arrow" size={15}/></button>}</div>}
            </div>
          </div>
          <div className="library-footer"><span><span className="status-dot"/> {format === 'raw' ? '支持索尼 · 佳能 · 尼康 · 哈苏及其他 RAW 格式' : '仅扫描 .jpg / .jpeg 文件'}</span><span>{scanned ? `${files.length} 个文件` : '等待导入'}</span></div>
        </section>

        <aside className="settings panel">
          <div className="panel-heading"><div><span className="eyebrow">03 / 设置归档</span><h2>给拍摄一个名字</h2></div><Icon name="folder" size={23}/></div>
          <div className="settings-content">
            <div className="archive-modes" role="group" aria-label="归档模式">
              <button className="secondary" type="button" disabled={!!busy} aria-pressed={!reuse} onClick={() => { if (reuse) { setMode('new'); setTarget(''); } }}>新建归档文件夹</button>
              <button className="secondary" type="button" disabled={!!busy} aria-pressed={reuse} onClick={() => { if (!reuse) { setMode('reuse'); setTarget(''); } }}>复用已有文件夹</button>
            </div>
            <label className="field-label">保存到 <span>{reuse ? '已存在的归档文件夹' : '上一级目录'}</span></label>
            <button className={`target-picker ${target ? 'has-target' : ''}`} disabled={!!busy || !api} onClick={() => pick(reuse ? 'existing' : 'target')} title={target}><Icon name="folder" size={18}/><span>{target || (reuse ? '选择已有归档文件夹' : '选择目标路径')}</span><span className="target-dots">···</span></button>
            <div className="divider"/>
            {reuse ? <div className="folder-preview"><div><Icon name="folder" size={15}/><span>直接复制，不建子文件夹</span></div><small>{dates.length > 1 ? '注意：已选多个拍摄日，照片会合并到同一个文件夹。' : '请选择真正存放照片的文件夹，而不是它的上一级目录。'}</small></div> : <>
              {[['location', '拍摄地点', '例如：上海浦东', '01'], ['theme', '拍摄主题', '例如：万圣夜主题', '02'], ['model', '模特 / 人物', '例如：小西', '03']].map(([key, label, placeholder, number]) => <label className="form-field" key={key}><span>{label}<small>{number}</small></span><input disabled={!!busy} value={fields[key]} maxLength={60} onChange={event => setFields(previous => ({ ...previous, [key]: event.target.value }))} placeholder={placeholder}/></label>)}
              <div className="folder-preview"><div><Icon name="folder" size={15}/><span>文件夹命名预览</span></div><code>{preview}</code><small>多选日期时，每一天会生成独立文件夹。</small></div>
            </>}
            <div className="safety-list"><div><Icon name="check" size={15}/> 保留原文件名 · 同名文件自动编号</div><div><Icon name="check" size={15}/> 逐个文件进行 SHA-256 完整性校验</div><div><Icon name="check" size={15}/> 全程本地处理，不上传照片</div></div>
          </div>
        </aside>
      </div>

      {busy && <section className="progress-panel" aria-live="polite"><div><strong>{busy === 'scan' ? progress?.phase === 'discover' ? `正在查找 ${formatLabel} 文件…` : '正在读取拍摄日期…' : '正在复制并校验…'}</strong><span>{progress?.current || '正在准备'} {progress?.total ? `· ${progress.done} / ${progress.total}` : ''}</span><button className="text-button" disabled={stopping} onClick={async () => { setStopping(true); try { await api.cancel(); } catch (err) { setError(err.message); setStopping(false); } }}>{stopping ? '等待当前文件完成…' : '停止任务'}</button></div><div className={`progress-track ${!progress?.total ? 'indeterminate' : ''}`}><span style={{ width: `${percent}%` }}/></div></section>}
      {result && <section className={`message result ${result.failed.length ? 'warning' : 'success'}`} role="status"><div><strong>{result.cancelled ? '归档已停止' : result.failed.length ? '归档结束，部分文件未完成' : '归档完成'}</strong><p>{result.copied.length} 个文件已复制并通过校验{result.failed.length ? `，${result.failed.length} 个文件失败` : ''}。存储卡原文件未修改。</p>{result.failed.length > 0 && <details><summary>查看失败原因（重试会为已复制文件另存编号副本）</summary>{result.failed.map((file, index) => <p key={index}>{file.name}：{file.error}</p>)}</details>}</div><button className="secondary" onClick={async () => { try { await api.reveal(); } catch (err) { setError(err.message); } }}>打开归档目录 <Icon name="arrow" size={16}/></button></section>}

      <footer className="action-bar"><div className="selection-summary"><span className="selection-icon"><Icon name="image" size={22}/></span><div><strong>已选择 <em>{chosen.length}</em> 张 {formatLabel}<span> / {dates.length} 个拍摄日</span></strong><small>{chosen.length ? `预计复制 ${bytes(totalSize)} · 仅包含 ${formatLabel}` : '勾选照片，或在左侧勾选整个拍摄日'}</small></div></div><div className="action-right"><span className="action-hint">{!chosen.length ? '先勾选照片，再开始归档' : !target ? '请选择目标路径' : !reuse && !validFields ? '请填写有效的地点、主题和模特' : '准备就绪，开始整理这次拍摄'}</span><button className="primary" disabled={!ready} onClick={() => setConfirm(true)}>开始归档 <Icon name="arrow" size={19}/></button></div></footer>
    </main>
    {previewIndex >= 0 && <PreviewDialog file={visible[previewIndex]} index={previewIndex} total={visible.length}
      checked={selected.has(previewId)} disabled={!canSelectDay} onToggle={togglePhoto}
      onClose={() => setPreviewId(null)} onMove={step => {
        const next = visible[previewIndex + step];
        if (next) setPreviewId(next.id);
      }}/>}
    {confirm && <div className="modal-backdrop" onClick={() => setConfirm(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={event => event.stopPropagation()}><span className="eyebrow">READY TO ARCHIVE</span><h2 id="confirm-title">确认这次归档</h2><p>将 {dates.length} 天内已勾选的 {chosen.length} 张 {formatLabel}（{bytes(totalSize)}）复制到：</p><div className="confirm-path">{target}</div>{reuse ? <p>{dates.length > 1 ? '多个拍摄日的照片将合并到此文件夹，不新建子文件夹。' : '直接复制到此文件夹，不新建子文件夹。'}</p> : <ul>{dates.map(date => <li key={date}>{date.replaceAll('-', '')}_{fields.location.trim()}_{fields.theme.trim()}_{fields.model.trim()} · {chosenCounts.get(date)} 张</li>)}</ul>}<p className="modal-note">只复制当前格式下已勾选的照片。原文件不会被删除，同名文件自动添加编号而不覆盖。</p><div className="modal-actions"><button className="secondary" onClick={() => setConfirm(false)}>返回检查</button><button className="primary" disabled={!ready} onClick={startCopy}>确认复制 <Icon name="arrow" size={18}/></button></div></section></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
