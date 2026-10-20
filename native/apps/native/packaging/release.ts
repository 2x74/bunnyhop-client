// Offline manifest signing only; this command never uploads/publishes an artifact.
import{createPrivateKey,createPublicKey,sign}from"node:crypto";import{readFileSync,writeFileSync}from"node:fs";import{parseArgs}from"node:util";
import{verifiedManifest,type Trust,type ReleaseManifest}from"./update";
if(import.meta.main){try{
 const{values}=parseArgs({args:Bun.argv.slice(2),options:{report:{type:"string",multiple:true},"url-base":{type:"string"},key:{type:"string",default:process.env.BUNNYHOP_RELEASE_PRIVATE_KEY_FILE},"key-id":{type:"string"},out:{type:"string"},"valid-days":{type:"string",default:"14"}}});
 if(!values.report?.length||!values["url-base"]||!values.key||!values["key-id"]||!values.out)throw new Error("Usage: bun release.ts --report REPORT.json [--report ...] --url-base HTTPS_URL --key CONFIGURED_KEY_FILE --key-id ID --out NEW_ENVELOPE.json");
 const base=new URL(values["url-base"].replace(/\/?$/,"/"));if(base.protocol!=="https:"||base.username||base.password||base.search||base.hash)throw new Error("Release URL must be a plain HTTPS directory");
 if(!/^[A-Za-z0-9_.-]{1,64}$/.test(values["key-id"]))throw new Error("Invalid key id");
 const reports=values.report.map(p=>JSON.parse(readFileSync(p,"utf8")));if(reports.some(r=>r.schema!==1||!r.releaseEligible))throw new Error("A package is not release-eligible");
 if(new Set(reports.map(r=>r.version)).size!==1)throw new Error("Package versions differ");const days=Number(values["valid-days"]);if(!Number.isInteger(days)||days<1||days>30)throw new Error("valid-days must be1..30");
 const manifest:ReleaseManifest={schema:1,version:reports[0].version,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+days*86400000).toISOString(),artifacts:reports.map(r=>({platform:r.platform,filename:r.archive,url:new URL(r.archive,base).href,bytes:r.bytes,sha256:r.sha256,build:r.build}))};
 const key=createPrivateKey(readFileSync(values.key));if(key.asymmetricKeyType!=="ed25519")throw new Error("Release signing key must be Ed25519");
 const payload=Buffer.from(JSON.stringify(manifest)),envelope={keyId:values["key-id"],payload:payload.toString("base64"),signature:sign(null,payload,key).toString("base64")};
 const publicKey=createPublicKey(key).export({format:"pem",type:"spki"}).toString(),trust:Trust={schema:1,keys:[{id:values["key-id"],publicKey}],downloadOrigins:[base.origin]};verifiedManifest(Buffer.from(JSON.stringify(envelope)),trust);
 writeFileSync(values.out,JSON.stringify(envelope,null,2)+"\n",{flag:"wx",mode:0o644});console.log(JSON.stringify({signed:values.out,keyId:values["key-id"],version:manifest.version,artifacts:manifest.artifacts.length,published:false}));
 }catch(e){console.error(e instanceof Error?e.message:String(e));process.exit(1);}}
