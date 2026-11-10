// Shared opt-in native.html entry; ordinary performance runs retain their original page.
const config=(window as any).__OFFICE_PERFORMANCE__;
if(import.meta.env.OFFICE_PERFORMANCE && config?.page==='file-flows')void import('../file-flows/native-page');
else if(config?.page==='office-selection')void import('./native-page');
else void import('../office-performance/native-page');
