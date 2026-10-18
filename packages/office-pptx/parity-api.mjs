// Generated from the pinned upstream preload API.
export function createApi(ipcRenderer) {
    return {
        getLanguage: () => ipcRenderer.invoke('app:get-language'),
        onLanguageChanged: (handler) => {
            const listener = (_event, lang) => handler(lang);
            ipcRenderer.on('app:language-changed', listener);
            return () => ipcRenderer.removeListener('app:language-changed', listener);
        },
        getTheme: () => ipcRenderer.invoke('app:get-theme'),
        onThemeChanged: (handler) => {
            const listener = (_event, theme) => handler(theme);
            ipcRenderer.on('app:theme-changed', listener);
            return () => ipcRenderer.removeListener('app:theme-changed', listener);
        },
        getAutoSaveDefault: () => ipcRenderer.invoke('app:get-auto-save-default'),
        onAutoSaveDefaultChanged: (handler) => {
            const listener = (_event, value) => handler(value);
            ipcRenderer.on('app:auto-save-default-changed', listener);
            return () => ipcRenderer.removeListener('app:auto-save-default-changed', listener);
        },
        getAiPanelPrefs: () => ipcRenderer.invoke('app:get-ai-panel-prefs'),
        setAiPanelPrefs: (patch) => ipcRenderer.invoke('app:set-ai-panel-prefs', patch),
        onAiPanelPrefsChanged: (handler) => {
            const listener = (_event, prefs) => handler(prefs);
            ipcRenderer.on('app:ai-panel-prefs-changed', listener);
            return () => ipcRenderer.removeListener('app:ai-panel-prefs-changed', listener);
        },
        onChromePressed: (handler) => {
            const listener = () => handler();
            ipcRenderer.on('app:chrome-pressed', listener);
            return () => ipcRenderer.removeListener('app:chrome-pressed', listener);
        },
        setShowFullScreen: (on) => ipcRenderer.invoke('slides:show-fullscreen', on),
        privateFontFaces: () => ipcRenderer.invoke('slides:private-font-faces'),
        privateFontData: (id) => ipcRenderer.invoke('slides:private-font-data', id),
        fontCatalog: () => ipcRenderer.invoke('slides:font-catalog'),
        fontDownload: (family) => ipcRenderer.invoke('slides:font-download', family),
        fontInstallLocal: () => ipcRenderer.invoke('slides:font-install-local'),
        fontMissing: () => ipcRenderer.invoke('slides:font-missing'),
        onFontsChanged: (handler) => {
            const listener = () => handler();
            ipcRenderer.on('slides:fonts-changed', listener);
            return () => ipcRenderer.removeListener('slides:fonts-changed', listener);
        },
        openPptx: (fitWidthPx) => ipcRenderer.invoke('slides:open', fitWidthPx),
        openPptxPath: (path, fitWidthPx) => ipcRenderer.invoke('slides:open-path', path, fitWidthPx),
        consumePendingOpen: (fitWidthPx) => ipcRenderer.invoke('slides:consume-pending-open', fitWidthPx),
        consumeHeadlessExport: () => ipcRenderer.invoke('slides:consume-headless-export'),
        headlessExportDone: (result) => ipcRenderer.send('slides:headless-export-done', result),
        newBlank: (fitWidthPx) => ipcRenderer.invoke('slides:new-blank', fitWidthPx),
        landGeneratedPages: (pageMarkers, fitWidthPx, mode, atIndex, deckName) => ipcRenderer.invoke('slides:land-generated-pages', pageMarkers, fitWidthPx, mode, atIndex, deckName),
        cloudGenStatus: () => ipcRenderer.invoke('slides:cloud-gen-status'),
        cloudPageCancel: () => ipcRenderer.invoke('slides:cloud-page-cancel'),
        cloudGeneratePage: (op) => ipcRenderer.invoke('slides:cloud-page-generate', op),
        localGeneratePage: (op) => ipcRenderer.invoke('slides:local-page-generate', op),
        editText: (op) => ipcRenderer.invoke('slides:edit-text', op),
        setElementFont: (op) => ipcRenderer.invoke('slides:set-element-font', op),
        setElementParagraphFormat: (op) => ipcRenderer.invoke('slides:set-element-paragraph-format', op),
        findReplace: (op) => ipcRenderer.invoke('slides:find-replace', op),
        setSlideLayout: (op) => ipcRenderer.invoke('slides:set-slide-layout', op),
        setSlideSize: (op) => ipcRenderer.invoke('slides:set-slide-size', op),
        getSlideSize: () => ipcRenderer.invoke('slides:get-slide-size'),
        editTransform: (op) => ipcRenderer.invoke('slides:edit-transform', op),
        cancelTransformPreview: (op) => ipcRenderer.invoke('slides:cancel-transform-preview', op),
        editTransformMulti: (op) => ipcRenderer.invoke('slides:edit-transform-multi', op),
        editConnectorEndpoints: (op) => ipcRenderer.invoke('slides:edit-connector-endpoints', op),
        editPictureSrcRect: (op) => ipcRenderer.invoke('slides:edit-picture-src-rect', op),
        editPictureOpacity: (op) => ipcRenderer.invoke('slides:edit-picture-opacity', op),
        editImageFill: (op) => ipcRenderer.invoke('slides:edit-image-fill', op),
        changeShape: (op) => ipcRenderer.invoke('slides:change-shape', op),
        setShapeAdjust: (op) => ipcRenderer.invoke('slides:set-shape-adjust', op),
        setShapeGeometry: (op) => ipcRenderer.invoke('slides:set-shape-geometry', op),
        setTextAnchor: (op) => ipcRenderer.invoke('slides:set-text-anchor', op),
        setTextBodyProps: (op) => ipcRenderer.invoke('slides:set-text-body-props', op),
        setEffects: (op) => ipcRenderer.invoke('slides:set-effects', op),
        clipboardExternal: () => ipcRenderer.invoke('slides:clipboard-external'),
        groupElements: (op) => ipcRenderer.invoke('slides:group-elements', op),
        ungroupElement: (op) => ipcRenderer.invoke('slides:ungroup-element', op),
        batchEditTransform: (op) => ipcRenderer.invoke('slides:batch-edit-transform', op),
        getRenderSlides: () => ipcRenderer.invoke('slides:get-render-slides'),
        addElement: (op) => ipcRenderer.invoke('slides:add-element', op),
        deleteElement: (op) => ipcRenderer.invoke('slides:delete-element', op),
        deleteElements: (op) => ipcRenderer.invoke('slides:delete-elements', op),
        addSlide: (op) => ipcRenderer.invoke('slides:add-slide', op),
        addBlankSlide: (op) => ipcRenderer.invoke('slides:add-blank-slide', op),
        addSlideWithLayout: (op) => ipcRenderer.invoke('slides:add-slide-with-layout', op),
        getLayouts: () => ipcRenderer.invoke('slides:get-layouts'),
        masterEnter: (fitWidthPx) => ipcRenderer.invoke('slides:master-enter', fitWidthPx),
        masterOpen: (partPath) => ipcRenderer.invoke('slides:master-open', partPath),
        masterClose: () => ipcRenderer.invoke('slides:master-close'),
        masterEditText: (op) => ipcRenderer.invoke('slides:master-edit-text', op),
        masterEditTransform: (op) => ipcRenderer.invoke('slides:master-edit-transform', op),
        masterEditFill: (op) => ipcRenderer.invoke('slides:master-edit-fill', op),
        masterEditStroke: (op) => ipcRenderer.invoke('slides:master-edit-stroke', op),
        masterDeleteElement: (op) => ipcRenderer.invoke('slides:master-delete-element', op),
        editFill: (op) => ipcRenderer.invoke('slides:edit-fill', op),
        editStroke: (op) => ipcRenderer.invoke('slides:edit-stroke', op),
        flipElements: (op) => ipcRenderer.invoke('slides:flip-elements', op),
        editBackground: (op) => ipcRenderer.invoke('slides:edit-background', op),
        pickPictureFile: () => ipcRenderer.invoke('slides:pick-picture-file'),
        insertImage: (slideIndex, fitWidthPx) => ipcRenderer.invoke('slides:insert-image', slideIndex, fitWidthPx),
        copySlides: (op) => ipcRenderer.invoke('slides:copy-slides', op),
        pasteSlide: (op) => ipcRenderer.invoke('slides:paste-slide', op),
        repasteSlide: (op) => ipcRenderer.invoke('slides:repaste-slide', op),
        hasSlideClipboard: () => ipcRenderer.invoke('slides:has-slide-clipboard'),
        clipboardProbe: () => ipcRenderer.invoke('slides:clipboard-probe'),
        deleteSlide: (slideIndex) => ipcRenderer.invoke('slides:delete-slide', slideIndex),
        deleteSlides: (op) => ipcRenderer.invoke('slides:delete-slides', op),
        duplicateSlides: (op) => ipcRenderer.invoke('slides:duplicate-slides', op),
        reorderElement: (op) => ipcRenderer.invoke('slides:reorder-element', op),
        editTableCell: (op) => ipcRenderer.invoke('slides:edit-table-cell', op),
        tableStructure: (op) => ipcRenderer.invoke('slides:table-structure', op),
        tableMerge: (op) => ipcRenderer.invoke('slides:table-merge', op),
        setTableColWidth: (op) => ipcRenderer.invoke('slides:set-table-col-width', op),
        setTableRowHeight: (op) => ipcRenderer.invoke('slides:set-table-row-height', op),
        setTableCellAnchor: (op) => ipcRenderer.invoke('slides:set-table-cell-anchor', op),
        editTableStyle: (op) => ipcRenderer.invoke('slides:edit-table-style', op),
        editChart: (op) => ipcRenderer.invoke('slides:edit-chart', op),
        getChartColorSchemes: () => ipcRenderer.invoke('slides:chart-color-schemes'),
        getChartData: (slideIndex, sourceId) => ipcRenderer.invoke('slides:get-chart-data', slideIndex, sourceId),
        copyElements: (op) => ipcRenderer.invoke('slides:copy-elements', op),
        copyElementsImage: (clipboardToken, pngBase64) => ipcRenderer.invoke('slides:copy-elements-image', clipboardToken, pngBase64),
        pasteElements: (op) => ipcRenderer.invoke('slides:paste-elements', op),
        duplicateElements: (op) => ipcRenderer.invoke('slides:duplicate-elements', op),
        addTable: (op) => ipcRenderer.invoke('slides:add-table', op),
        addInk: (op) => ipcRenderer.invoke('slides:add-ink', op),
        addChart: (op) => ipcRenderer.invoke('slides:add-chart', op),
        addSmartArt: (op) => ipcRenderer.invoke('slides:add-smartart', op),
        addImageBytes: (op) => ipcRenderer.invoke('slides:add-image-bytes', op),
        replacePictureBytes: (op) => ipcRenderer.invoke('slides:replace-picture-bytes', op),
        insertMedia: (slideIndex, kind, fitWidthPx) => ipcRenderer.invoke('slides:insert-media', slideIndex, kind, fitWidthPx),
        addMediaBytes: (op) => ipcRenderer.invoke('slides:add-media-bytes', op),
        getMediaData: (slideIndex, sourceId) => ipcRenderer.invoke('slides:media-data', slideIndex, sourceId),
        insertModel3d: (slideIndex, fitWidthPx) => ipcRenderer.invoke('slides:insert-model3d', slideIndex, fitWidthPx),
        setLink: (op) => ipcRenderer.invoke('slides:set-link', op),
        getLink: (slideIndex, sourceId) => ipcRenderer.invoke('slides:get-link', slideIndex, sourceId),
        getSlideLinks: (slideIndex) => ipcRenderer.invoke('slides:get-slide-links', slideIndex),
        getRunLinks: (slideIndex) => ipcRenderer.invoke('slides:get-run-links', slideIndex),
        applyHeaderFooter: (op) => ipcRenderer.invoke('slides:apply-header-footer', op),
        getHeaderFooter: (slideIndex) => ipcRenderer.invoke('slides:get-header-footer', slideIndex),
        applyTheme: (op) => ipcRenderer.invoke('slides:apply-theme', op),
        setTransition: (op) => ipcRenderer.invoke('slides:set-transition', op),
        getTransition: (slideIndex) => ipcRenderer.invoke('slides:get-transition', slideIndex),
        setAdvanceTimes: (op) => ipcRenderer.invoke('slides:set-advance-times', op),
        getAnimations: (slideIndex) => ipcRenderer.invoke('slides:get-animations', slideIndex),
        getShapeKeys: (slideIndex) => ipcRenderer.invoke('slides:get-shape-keys', slideIndex),
        setAnimations: (op) => ipcRenderer.invoke('slides:set-animations', op),
        setSlideHidden: (op) => ipcRenderer.invoke('slides:set-hidden', op),
        setSlidesHidden: (op) => ipcRenderer.invoke('slides:set-slides-hidden', op),
        getSections: () => ipcRenderer.invoke('slides:get-sections'),
        setSections: (sections) => ipcRenderer.invoke('slides:set-sections', sections),
        addSection: (op) => ipcRenderer.invoke('slides:add-section', op),
        renameSection: (op) => ipcRenderer.invoke('slides:rename-section', op),
        removeSection: (op) => ipcRenderer.invoke('slides:remove-section', op),
        removeSectionSlides: (op) => ipcRenderer.invoke('slides:remove-section-slides', op),
        moveSection: (op) => ipcRenderer.invoke('slides:move-section', op),
        moveSlide: (op) => ipcRenderer.invoke('slides:move-slide', op),
        moveSlides: (op) => ipcRenderer.invoke('slides:move-slides', op),
        getNotes: (slideIndex) => ipcRenderer.invoke('slides:get-notes', slideIndex),
        setNotes: (op) => ipcRenderer.invoke('slides:set-notes', op),
        getComments: (slideIndex) => ipcRenderer.invoke('slides:get-comments', slideIndex),
        addComment: (op) => ipcRenderer.invoke('slides:add-comment', op),
        deleteComment: (op) => ipcRenderer.invoke('slides:delete-comment', op),
        nativeClipboard: (op) => ipcRenderer.invoke('slides:native-clipboard', op),
        beginHistoryBatch: () => ipcRenderer.invoke('slides:history-batch-begin'),
        endHistoryBatch: () => ipcRenderer.invoke('slides:history-batch-end'),
        applyEditScript: (op) => ipcRenderer.invoke('slides:apply-edit-script', op),
        applyTxn: (op) => ipcRenderer.invoke('slides:apply-txn', op),
        aiSnapshotRestore: (id) => ipcRenderer.invoke('slides:ai-snapshot-restore', id),
        undo: () => ipcRenderer.invoke('slides:undo'),
        redo: () => ipcRenderer.invoke('slides:redo'),
        pickExportDir: () => ipcRenderer.invoke('slides:pick-export-dir'),
        exportImages: (op) => ipcRenderer.invoke('slides:export-images', op),
        pickExportPdfPath: (defaultName) => ipcRenderer.invoke('slides:pick-export-pdf-path', defaultName),
        savePicture: (op) => ipcRenderer.invoke('slides:save-picture', op),
        exportPdf: (op) => ipcRenderer.invoke('slides:export-pdf', op),
        printSlides: (op) => ipcRenderer.invoke('slides:print', op),
        save: () => ipcRenderer.invoke('slides:save'),
        saveAs: (defaultName) => ipcRenderer.invoke('slides:save-as', defaultName),
        onCloseSaveRequest: (handler) => {
            const listener = () => handler();
            ipcRenderer.on('slides:close-save-request', listener);
            return () => ipcRenderer.removeListener('slides:close-save-request', listener);
        },
        onHistoryChanged: (handler) => {
            const listener = (_e, state) => handler(state);
            ipcRenderer.on('slides:history-changed', listener);
            return () => ipcRenderer.removeListener('slides:history-changed', listener);
        },
        onDeckChanged: (handler) => {
            const listener = (_e, state) => handler(state);
            ipcRenderer.on('slides:deck-changed', listener);
            return () => ipcRenderer.removeListener('slides:deck-changed', listener);
        },
        reportCloseSaveResult: (ok) => ipcRenderer.send('slides:close-save-result', ok === true),
        setAutoSavePref: (on) => ipcRenderer.send('slides:autosave-pref', on === true),
        isDirty: () => ipcRenderer.invoke('slides:is-dirty'),
        getRecentFiles: () => ipcRenderer.invoke('slides:recent'),
        onMenuCommand: (handler) => {
            const listener = (_e, cmd) => handler(cmd);
            ipcRenderer.on('slides:menu', listener);
            return () => ipcRenderer.removeListener('slides:menu', listener);
        },
        onOpened: (handler) => {
            const listener = (_e, result) => handler(result);
            ipcRenderer.on('slides:opened', listener);
            return () => ipcRenderer.removeListener('slides:opened', listener);
        },
        onRenamed: (handler) => {
            const listener = (_e, newPath) => handler(newPath);
            ipcRenderer.on('slides:renamed', listener);
            return () => ipcRenderer.removeListener('slides:renamed', listener);
        },
        getAiSettings: () => ipcRenderer.invoke('ai:get-settings'),
        setAiSettings: (settings) => ipcRenderer.invoke('ai:set-settings', settings),
        onAiSettingsChanged: (handler) => {
            const listener = () => handler();
            ipcRenderer.on('ai:settings-changed', listener);
            return () => ipcRenderer.removeListener('ai:settings-changed', listener);
        },
        openAiModelSettings: () => ipcRenderer.invoke('ai:open-model-settings'),
        aiStream: (request) => ipcRenderer.invoke('ai:stream', request),
        aiStreamCancel: (requestId) => ipcRenderer.invoke('ai:stream-cancel', requestId),
        aiGskStatus: (withEmail) => ipcRenderer.invoke('ai:gsk-status', withEmail),
        aiGskLogin: () => ipcRenderer.invoke('ai:gsk-login'),
        aiLogRunFailure: (entry) => ipcRenderer.invoke('ai:log-run-failure', entry),
        webSearch: (query, maxResults) => ipcRenderer.invoke('ai:web-search', query, maxResults),
        imageSearch: (query, maxResults) => ipcRenderer.invoke('ai:image-search', query, maxResults),
        insertImageUrl: (op) => ipcRenderer.invoke('ai:insert-image-url', op),
        replacePictureUrl: (op) => ipcRenderer.invoke('ai:replace-picture-url', op),
        generateImage: (op) => ipcRenderer.invoke('ai:generate-image', op),
        analyzeMedia: (op) => ipcRenderer.invoke('ai:analyze-media', op),
        gskStatus: () => ipcRenderer.invoke('ai:gsk-status'),
        onAiStream: (handler) => {
            const listener = (_e, chunk) => handler(chunk);
            ipcRenderer.on('ai:stream-chunk', listener);
            return () => ipcRenderer.removeListener('ai:stream-chunk', listener);
        },
        saveStyleSidecar: (data) => ipcRenderer.invoke('ai:save-sidecar', data),
        saveStyleTemplate: (name, data) => ipcRenderer.invoke('ai:save-style-template', name, data),
        listStyleTemplates: () => ipcRenderer.invoke('ai:list-style-templates'),
        loadStyleTemplate: (name) => ipcRenderer.invoke('ai:load-style-template', name),
        presenterStart: () => ipcRenderer.invoke('slides:presenter-start'),
        presenterSync: (state) => ipcRenderer.send('slides:presenter-sync', state),
        presenterInk: (ev) => ipcRenderer.send('slides:presenter-ink', ev),
        presenterSwap: () => ipcRenderer.invoke('slides:presenter-swap'),
        presenterEnd: () => ipcRenderer.invoke('slides:presenter-end'),
        audienceReady: () => ipcRenderer.invoke('slides:audience-ready'),
        audienceNav: (action) => ipcRenderer.send('slides:audience-nav', action),
        onShowSync: (handler) => {
            const listener = (_e, state) => handler(state);
            ipcRenderer.on('slides:show-sync', listener);
            return () => ipcRenderer.removeListener('slides:show-sync', listener);
        },
        onShowInk: (handler) => {
            const listener = (_e, ev) => handler(ev);
            ipcRenderer.on('slides:show-ink', listener);
            return () => ipcRenderer.removeListener('slides:show-ink', listener);
        },
        onAudienceNav: (handler) => {
            const listener = (_e, action) => handler(action);
            ipcRenderer.on('slides:audience-nav', listener);
            return () => ipcRenderer.removeListener('slides:audience-nav', listener);
        },
    };
}
