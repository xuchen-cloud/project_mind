// Shared opt-in native.html entry; ordinary performance runs retain their original page.
const config=(window as any).__OFFICE_PERFORMANCE__;
if(config?.page==='office-selection')void import('./native-page');
else void import('../office-performance/native-page');
