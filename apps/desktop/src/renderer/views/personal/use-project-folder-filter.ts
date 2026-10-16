import { useEffect, useRef, useState } from "react";
import { projectFolderFilterSchema } from "../../../ipc/project-folder-filter.js";

let pendingWrites = Promise.resolve();

export function useProjectFolderFilter(projectId: string | undefined) {
  const [state, setState] = useState({
    projectId,
    hidden: [] as string[],
    loading: Boolean(projectId),
    error: ""
  });
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const invoke = window.koedDesktop?.invoke;
    setState({
      projectId,
      hidden: [],
      loading: Boolean(projectId && invoke),
      error: ""
    });
    if (!projectId || !invoke) return;
    void pendingWrites
      .then(() => invoke("project_folder_filter_get", { projectId }))
      .then((result) => {
        if (!active) return;
        const value = projectFolderFilterSchema.parse(result);
        if (value.projectId !== projectId)
          throw new Error("Folder filter Project differs.");
        setState({
          projectId,
          hidden: value.hiddenFolderIds,
          loading: false,
          error: ""
        });
      })
      .catch(() => {
        if (active)
          setState({
            projectId,
            hidden: [],
            loading: false,
            error:
              "Saved folder filters are unavailable. All folders are shown."
          });
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  const change = (hiddenFolderIds: string[]) => {
    if (!projectId) return;
    const version = ++revision.current;
    setState({ projectId, hidden: hiddenFolderIds, loading: false, error: "" });
    const invoke = window.koedDesktop?.invoke;
    if (!invoke) return;
    pendingWrites = pendingWrites
      .catch(() => undefined)
      .then(async () => {
        try {
          await invoke(
            "project_folder_filter_set",
            projectFolderFilterSchema.parse({ projectId, hiddenFolderIds })
          );
        } catch {
          if (
            currentProject.current === projectId &&
            revision.current === version
          )
            setState((value) => ({
              ...value,
              error:
                "The folder filter works for this view, but Koed cannot save it."
            }));
        }
      });
  };
  return {
    hiddenFolderIds: state.projectId === projectId ? state.hidden : [],
    loading: state.projectId === projectId ? state.loading : Boolean(projectId),
    error: state.projectId === projectId ? state.error : "",
    change
  };
}
