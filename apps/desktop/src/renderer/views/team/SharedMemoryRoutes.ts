/**
 * Shell-neutral Shared Memory route bodies.
 *
 * The source/discussion route retains the current grant, representation,
 * paging, and authority-loss workflows without owning either shell sidebar.
 */
export {
  SharedMemoryIndex as SharedMemoryIndexRoute,
  SharedSessionView as SharedSessionRoute
} from "../../collaboration/CollaborationRoutesImpl.js";
