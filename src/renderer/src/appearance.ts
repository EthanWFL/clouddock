import type { AppAppearance, OpsDockApi } from "../../shared/api";

type AppearanceApi = Pick<OpsDockApi, "getAppearance" | "subscribeAppearance">;

export function synchronizeAppearance(
  api: AppearanceApi,
  apply: (appearance: AppAppearance) => void,
): () => void {
  let revision = 0;
  const unsubscribe = api.subscribeAppearance((appearance) => {
    revision += 1;
    apply(appearance);
  });
  const initialRevision = revision;
  void api.getAppearance().then((appearance) => {
    if (revision === initialRevision) apply(appearance);
  }).catch(() => undefined);
  return unsubscribe;
}
