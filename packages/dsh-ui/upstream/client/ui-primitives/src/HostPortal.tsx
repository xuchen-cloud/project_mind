import { createContext, useContext, type ReactNode } from 'react'

const HostPortalContext = createContext<HTMLElement | null>(null)

/** Keep floating UI inside the owning host's themed portal surface. */
export function HostPortalProvider({ value, children }: { value: HTMLElement; children: ReactNode }) {
  return <HostPortalContext.Provider value={value}>{children}</HostPortalContext.Provider>
}

/** Standalone DSH retains its original document-body portal behavior. */
export function useHostPortalContainer(): HTMLElement {
  return useContext(HostPortalContext) ?? document.body
}
