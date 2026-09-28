import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const router = Router();
const RESOURCE_URL = String(process.env.MCP_RESOURCE_URL ?? "https://universal-server1.onrender.com").replace(/\/$/, "");
const OAUTH_ISSUER = String(process.env.MCP_OAUTH_ISSUER ?? "https://integrated-system-gzyu.onrender.com").replace(/\/$/, "");
const MCP_SECRET = String(process.env.MCP_OAUTH_SECRET ?? "");
const PORT = String(process.env.PORT ?? "10000");
const AURORA_AGENT_URL = String(process.env.AURORA_AGENT_URL ?? "https://aurora-agent-o9x5.onrender.com").replace(/\/$/, "");

type Claims = { iss:string; aud:string; sub:string; username?:string; scope?:string; iat:number; exp:number; __token?:string };

const READ_SECURITY = [{ type: "oauth2", scopes: ["aura.read"] }];
const EXECUTE_SECURITY = [{ type: "oauth2", scopes: ["aura.execute"] }];
const resultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  result: z.unknown().optional(),
  traceId: z.string().optional(),
  requestId: z.string().optional(),
  reason: z.string().optional(),
});

function b64(value:string|Buffer){return Buffer.from(value).toString("base64url");}
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function token(req:Request){return String(req.headers.authorization??"").replace(/^Bearer\s+/i,"").trim();}
function verify(raw:string, scope?:string):Claims|null{
  if(!MCP_SECRET)return null;
  const p=raw.split("."); if(p.length!==3)return null;
  let h:any,c:Claims; try{h=JSON.parse(Buffer.from(p[0],"base64url").toString());c=JSON.parse(Buffer.from(p[1],"base64url").toString())}catch{return null}
  const sig=b64(crypto.createHmac("sha256",MCP_SECRET).update(`${p[0]}.${p[1]}`).digest());
  const now=Math.floor(Date.now()/1000),scopes=String(c.scope??"").split(/\s+/).filter(Boolean);
  if(h?.alg!=="HS256"||h?.typ!=="JWT"||!equal(sig,p[2])||c.iss!==OAUTH_ISSUER||c.aud!==RESOURCE_URL||!c.sub||c.exp<=now||c.iat>now+120)return null;
  if(scope&&!scopes.includes(scope))return null;
  return {...c,__token:raw};
}
function challenge(res:Response,scope="aura.read"){res.setHeader("WWW-Authenticate",`Bearer resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource", scope="${scope}"`);}
function auth(req:Request,res:Response){const c=verify(token(req));if(!c){challenge(res);res.status(401).json({error:"unauthorized",error_description:"A valid OAuth access token is required."});return null}return c;}
async function local(path:string,options:RequestInit={}){
  const response=await fetch(`http://127.0.0.1:${PORT}${path}`,{...options,headers:{Accept:"application/json",...(options.headers??{})},signal:options.signal??AbortSignal.timeout(10000)});
  const text=await response.text();let result:any=null;try{result=text?JSON.parse(text):null}catch{result={raw:text}}
  return {ok:response.ok,status:response.status,result};
}
function authError(scope:string){return {isError:true,content:[{type:"text" as const,text:`Authentication required for ${scope}.`}],_meta:{"mcp/www_authenticate":[`Bearer resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="The ${scope} scope is required."`]}};}
function serverFor(claims:Claims){
  const server=new McpServer({name:"aura-supreme-operator",version:"1.1.0"},{instructions:"Use read tools to inspect the Aura ecosystem before execution. Use execute_supreme_action only when the user explicitly requests an operation. Every action is routed through the existing Supreme Operator and retains trace/request correlation."});
  server.registerTool("get_profile",{
    title:"Get connected profile",
    description:"Return the profile represented by the authenticated Aura connection.",
    inputSchema:{},
    outputSchema:{id:z.string().min(1),name:z.string().optional(),nickname:z.string().optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},
    securitySchemes:READ_SECURITY,_meta:{"openai/profile":true,securitySchemes:READ_SECURITY},
  },async()=>{const p={id:claims.sub,...(claims.username?{name:claims.username,nickname:claims.username}:{})};return{structuredContent:p,content:[{type:"text",text:JSON.stringify(p)}]}});
  server.registerTool("get_universal_health",{
    title:"Get Universal Server health",description:"Inspect Universal Server health without changing state.",inputSchema:{},outputSchema:resultSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}
  },async()=>{const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();const r=await local("/api/healthz",{headers:{"x-trace-id":traceId,"x-request-id":requestId}});const o={ok:r.ok,status:r.status,result:r.result,traceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});
  server.registerTool("get_capabilities",{
    title:"Get Aura system capabilities",description:"Inspect capabilities exposed through Universal Server and the Supreme Operator.",inputSchema:{},outputSchema:resultSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}
  },async()=>{const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();const r=await local("/api/agent/capabilities",{headers:{"x-trace-id":traceId,"x-request-id":requestId,"x-aurora-operator-mode":"supreme"}});const o={ok:r.ok,status:r.status,result:r.result,traceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});
  server.registerTool("get_diagnostics",{
    title:"Get Aurora diagnostics",description:"Inspect Aurora correlation and diagnostic state without changing state.",inputSchema:{traceId:z.string().min(1).optional()},outputSchema:resultSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}
  },async({traceId})=>{const requestTraceId=crypto.randomUUID(),requestId=crypto.randomUUID(),path=traceId?`/api/diagnostics/aurora/${encodeURIComponent(traceId)}`:"/api/diagnostics/aurora";const r=await local(path,{headers:{"x-trace-id":requestTraceId,"x-request-id":requestId,"x-aurora-operator-mode":"supreme"}});const o={ok:r.ok,status:r.status,result:r.result,traceId:requestTraceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});
  server.registerTool("get_aurora_status",{
    title:"Get Aurora Agent status",description:"Check the deployed Aurora Agent health endpoint without changing state.",inputSchema:{},outputSchema:resultSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}
  },async()=>{const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();const r=await fetch(`${AURORA_AGENT_URL}/health`,{headers:{Accept:"application/json","x-trace-id":traceId,"x-request-id":requestId},signal:AbortSignal.timeout(10000)});const text=await r.text();let result:any=null;try{result=text?JSON.parse(text):null}catch{result={raw:text}}const o={ok:r.ok,status:r.status,result,traceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});
  server.registerTool("execute_supreme_action",{
    title:"Execute a Supreme Operator action",
    description:"Execute an explicit user-requested Aura operation through the existing Supreme Operator. This may change system state.",
    inputSchema:{domain:z.string().min(1),action:z.string().min(1),args:z.record(z.unknown()).optional().default({})},
    outputSchema:z.object({ok:z.boolean(),executed:z.boolean().optional(),status:z.number().int().optional(),result:z.unknown().optional(),traceId:z.string(),requestId:z.string()}),
    annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false},securitySchemes:EXECUTE_SECURITY,_meta:{securitySchemes:EXECUTE_SECURITY}
  },async({domain,action,args})=>{
    if(!verify(claims.__token??"","aura.execute"))return authError("aura.execute");
    const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();
    const r=await local("/api/supreme/tool",{method:"POST",headers:{"content-type":"application/json","x-trace-id":traceId,"x-request-id":requestId,"x-aurora-operator-mode":"supreme",authorization:`Bearer ${claims.__token}`},body:JSON.stringify({target:"agent",domain:domain.trim().toLowerCase(),action:action.trim().toLowerCase(),args:args??{},operatorMode:"supreme",traceId,requestId}),signal:AbortSignal.timeout(50000)});
    const o={ok:r.ok,executed:Boolean(r.result?.executed),status:r.status,result:r.result,traceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}
  });
  return server;
}

router.get("/.well-known/oauth-protected-resource",(_req,res)=>res.json({resource:RESOURCE_URL,authorization_servers:[OAUTH_ISSUER],scopes_supported:["aura.read","aura.execute"],resource_documentation:`${RESOURCE_URL}/mcp`}));
router.all("/mcp",async(req:Request,res:Response)=>{
  if(req.method==="OPTIONS"){res.status(204).end();return}
  if(req.method!=="POST"){res.setHeader("Allow","POST, OPTIONS");res.status(405).json({error:"method_not_allowed"});return}
  const claims=auth(req,res);if(!claims)return;
  const server=serverFor(claims);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body)}
  catch(error){if(!res.headersSent)res.status(500).json({error:"mcp_request_failed",message:error instanceof Error?error.message:"MCP request failed"})}
  finally{try{await transport.close()}catch{}try{await server.close()}catch{}}
});
export default router;
