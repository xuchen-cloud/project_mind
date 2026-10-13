/** Read the exact Session's durable selection; shared settings are never a run label. */
export function observeSessionModel(reference, changed) {
  const { session } = reference.binding;
  const model = session.projections.faceOf('modelSelection');
  const update = () => {
    const state = session.getSnapshot();
    const projection = model.getSnapshot();
    const selection = state.running ? projection?.lastUsed : projection?.next ?? projection?.lastUsed;
    changed({ sessionId: state.sessionId, running: state.running, model: selection?.model ?? null,
      ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) });
  };
  const unsubscribeSession = session.subscribe(update);
  const unsubscribeModel = model.subscribe(update);
  update();
  return () => { unsubscribeSession(); unsubscribeModel(); };
}
