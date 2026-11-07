import { rolldown } from 'rolldown';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const folder=await mkdtemp(join(tmpdir(),'oc-sandbox-'));
try {const bundle=await rolldown({input:resolve('scripts/tests/sandboxTransactions.ts'),platform:'node'});const file=join(folder,'test.mjs');await bundle.write({file,format:'esm'});await bundle.close();await import(pathToFileURL(file).href);}finally{await rm(folder,{recursive:true,force:true});}
