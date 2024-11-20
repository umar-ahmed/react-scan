import { registerDevtoolsHook } from './fiber';

// __REACT_DEVTOOLS_GLOBAL_HOOK__ must exist before React is ever executed
// this is the case with the React Devtools extension, but without it, we need

// sometimes in expo this comes back as undefined
// registerDevtoolsHook({
//   onCommitFiberRoot() {
//     /**/
//   },
// });
