// Project Mind adapter: locale comes from the host; no Electron IPC.
import { strings } from './strings';
export type StringKey=keyof typeof strings.zh;
export function t(key:StringKey,params?:Record<string,string|number>):string {
  return strings.zh[key].replace(/\{(\w+)\}/g,(match,name:string)=>String(params?.[name]??match));
}
export function useI18n(){return {lang:'zh' as const,t};}
