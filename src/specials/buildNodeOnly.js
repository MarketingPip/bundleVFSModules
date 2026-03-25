/* import globals from "https://esm.sh/globals";

 
// const browserOnly = Object.getOwnPropertyNames(globalThis).sort();
const browserOnly =  Object.keys(globals.browser).filter(key => !key.includes('.'))



// node -e "console.log(JSON.stringify(Object.getOwnPropertyNames(globalThis).sort()))"
const nodeOnly =  Object.keys(globals.node)
 


 
 


export const REMOVABLE_BROWSER_APIS = browserOnly.filter(key => !nodeOnly.includes(key))

 

export function REMOVE_BROWSER_APIS(){
  for (const api of REMOVABLE_BROWSER_APIS) {
    if (typeof window !== 'undefined') {
      try {

        Object.defineProperty(window, api, {
          value: undefined,
          writable: true,      // allow reassignment if needed
          configurable: true,  // allow deletion or redefinition
          enumerable: false    // usually globals are non-enumerable
        });
      } catch (err) {
        // Some globals may be non-configurable in strict browsers
        // console.warn(`Could not override window.${api}:`, err);
      }
    }
  }
}
*/
