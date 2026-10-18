import type {CSSProperties} from 'react';

export interface StatusZoomProps {
  /** Percent, not a scale ratio. Each editor retains its native bounds. */
  value: number;
  min: number;
  max: number;
  /** Default button increment. The range always accepts whole percentages. */
  step: number;
  onChange: (value: number) => void;
  onValueClick?: () => void;
  disabled?: boolean;
  /** Preserve native notch/command semantics, independently of range granularity. */
  onStep?: (direction: -1 | 1) => void;
}

/** Shared viewing control. Read-only documents can still zoom. Import status-bar.css last. */
export function StatusZoom({value,min,max,step,onChange,onValueClick,disabled=false,onStep}: StatusZoomProps) {
  const change=(next:number)=>onChange(Math.min(max,Math.max(min,next)));
  const move=(direction:-1|1)=>onStep?onStep(direction):change(value+direction*step);
  const progress=Math.min(100,Math.max(0,(value-min)/(max-min)*100));
  return <div className="pm-status-zoom" role="group" aria-label="缩放">
    <button type="button" className="pm-status-zoom__button zoom-btn" aria-label="缩小" disabled={disabled||value<=min} onClick={()=>move(-1)}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 8h10"/></svg>
    </button>
    <input className="pm-status-zoom__range zoom-slider" type="range" aria-label="缩放比例" aria-valuetext={`${Math.round(value)}%`} min={min} max={max} step={1} value={value} disabled={disabled}
      style={{'--pm-zoom-progress':`${progress}%`} as CSSProperties} onChange={event=>change(Number(event.currentTarget.value))}/>
    <button type="button" className="pm-status-zoom__button zoom-btn" aria-label="放大" disabled={disabled||value>=max} onClick={()=>move(1)}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 8h10M8 3v10"/></svg>
    </button>
    <button type="button" className="pm-status-zoom__value zoom-value" aria-label="缩放百分比" title={onValueClick?'设置缩放比例':undefined} disabled={disabled||!onValueClick} onClick={onValueClick}>{Math.round(value)}%</button>
  </div>;
}
