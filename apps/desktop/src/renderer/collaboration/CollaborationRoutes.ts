/** Shell-neutral collaboration routes owned by the Desktop React root. */
export {
  CollaborationRoutes,
  CollaborationModalLayer,
  type CollaborationModalState,
  type CollaborationRoutesProps,
  type CollaborationSelectionFailure
} from "./CollaborationRoutesImpl.js";
export {
  type CollaborationDrafts,
  draftAuthorityForThread
} from "./ThreadRoute.js";
export { TeamPeopleRoute } from "../views/team/PeopleRoute.js";
export {
  SharedMemoryIndexRoute,
  SharedSessionRoute
} from "../views/team/SharedMemoryRoutes.js";
