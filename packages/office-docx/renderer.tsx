import {setAltChunkHtmlConverter} from './upstream/packages/docx-engine/src/index';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { App } from './upstream/apps/docs/src/renderer/App';
import { LocaleProvider, setModuleLang } from './upstream/apps/docs/src/renderer/i18n/locale';
import { buildDocBytes,exportHtml,printDoc,exportPdf,exportImages } from './upstream/apps/docs/src/renderer/file-actions';
import { isDocDirty } from './upstream/apps/docs/src/renderer/doc-dirty';
import { installScreenTips } from './upstream/packages/ui/src/screentip';
import './upstream/packages/ui/src/tokens.css';
import './upstream/packages/ui/src/dropdown.css';
import './upstream/packages/ui/src/color-picker.css';
import './upstream/packages/ui/src/find-panel.css';
import './upstream/packages/ui/src/screentip.css';
import './upstream/packages/ui/src/image-viewer.css';
import './upstream/packages/ui/src/ribbon-collapse.css';
import './upstream/apps/docs/src/renderer/styles.css';
import './upstream/apps/docs/src/renderer/fonts/fonts.css';
import './renderer.css';
import {installScrollEdges} from './scroll-edges';
import { initializeHost } from './renderer-host';
initializeHost({ buildDocBytes, isDocDirty,exportHtml,printDoc,exportPdf,exportImages });
setAltChunkHtmlConverter(html=>window.desktop.convertAltChunkHtml(html));
setModuleLang('zh');
document.documentElement.lang='zh-CN';
installScreenTips();
installScrollEdges();
// Commit the initial large renderer synchronously. Otherwise React can yield
// past useEditor's unmounted-instance disposal timer on WebKit, leaving App's
// first effects with a destroyed editor. Subsequent editing stays concurrent.
flushSync(()=>createRoot(document.getElementById('root')!).render(<LocaleProvider initial="zh"><App /></LocaleProvider>));
