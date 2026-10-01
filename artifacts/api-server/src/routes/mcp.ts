import crypto from "node:crypto";
import type { ServerResponse } from "node:http";
import { Router, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { executeOperatorPlatformRequest, getUnifiedOperatorAccess, listOperatorPlatforms } from "./operator";

const router = Router();
const RESOURCE_URL = String(process.env.MCP_RESOURCE_URL ?? "https://universal-server1.onrender.com").replace(/\/$/, "");
const OAUTH_ISSUER = String(process.env.MCP_OAUTH_ISSUER ?? "https://integrated-system-gzyu.onrender.com").replace(/\/$/, "");
const MCP_SECRET = String(process.env.MCP_OAUTH_SECRET ?? "");
const PORT = String(process.env.PORT ?? "10000");
const AURORA_AGENT_URL = String(process.env.AURORA_AGENT_URL ?? "https://aurora-agent-o9x5.onrender.com").replace(/\/$/, "");

type McpMonitorEvent = {
  id: string; timestamp: string; stage: string; method: string; path: string;
  status?: number; durationMs?: number; source?: string; userAgent?: string; detail?: string;
  origin?: string; ip?: string; forwardedFor?: string; host?: string; contentType?: string;
  accept?: string; authorizationPresent?: boolean; originHeader?: string; referer?: string;
  kind?: "event" | "heartbeat";
};

function requestContext(req: Request) {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").trim();
  const realIp = String(req.headers["x-real-ip"] ?? "").trim();
  const ip = forwarded.split(",")[0]?.trim() || realIp || req.ip || "";
  const userAgent = String(req.headers["user-agent"] ?? "");
  const origin = String(req.headers.origin ?? "");
  const referer = String(req.headers.referer ?? "");
  const host = String(req.headers.host ?? "");
  const accept = String(req.headers.accept ?? "");
  const contentType = String(req.headers["content-type"] ?? "");
  const authorizationPresent = Boolean(req.headers.authorization);
  const source = userAgent.toLowerCase().includes("chatgpt") ? "ChatGPT" : "external-client";
  return { source, userAgent, ip, forwardedFor: forwarded, host, contentType, accept, originHeader: origin, referer, authorizationPresent };
}
const MCP_MONITOR_MAX = 200;
const mcpMonitorEvents: McpMonitorEvent[] = [];
const mcpMonitorListeners = new Set<ServerResponse>();

function recordMcpEvent(event: Omit<McpMonitorEvent, "id" | "timestamp">) {
  const item: McpMonitorEvent = { ...event, kind: event.kind ?? "event", id: crypto.randomUUID(), timestamp: new Date().toISOString() };
  mcpMonitorEvents.push(item);
  if (mcpMonitorEvents.length > MCP_MONITOR_MAX) mcpMonitorEvents.splice(0, mcpMonitorEvents.length - MCP_MONITOR_MAX);
  const payload = "data: " + JSON.stringify(item) + "\\n\\n";
  for (const response of mcpMonitorListeners) {
    try { response.write(payload); } catch { mcpMonitorListeners.delete(response); }
  }
  return item;
}

export function getMcpMonitorSnapshot() {
  const last = mcpMonitorEvents[mcpMonitorEvents.length - 1] ?? null;
  return {
    online: true, endpoint: "/mcp", transport: "Streamable HTTP",
    oauth: {
      protectedResourceMetadata: "/.well-known/oauth-protected-resource",
      authorizationServer: OAUTH_ISSUER, pkce: "S256", clientRegistration: "CIMD",
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    },
    lastRequestAt: last?.timestamp ?? null, lastStatus: last?.status ?? null,
    events: [...mcpMonitorEvents].reverse(),
  };
}

export function streamMcpMonitor(response: ServerResponse) {
  mcpMonitorListeners.add(response);
  try { response.write(": connected\n\n"); } catch {}
  for (const event of mcpMonitorEvents.slice(-50)) {
    try { response.write("data: " + JSON.stringify(event) + "\\n\\n"); } catch { break; }
  }
  response.on("close", () => mcpMonitorListeners.delete(response));
}

const mcpHeartbeat = setInterval(() => {
  const last = mcpMonitorEvents[mcpMonitorEvents.length - 1] ?? null;
  const payload = "data: " + JSON.stringify({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    stage: last ? "monitor-heartbeat" : "mcp-verificando",
    method: "SYSTEM",
    path: "/mcp",
    status: last?.status ?? 200,
    source: "Universal Server",
    kind: "heartbeat",
    detail: last
      ? `Monitor ativo. Última etapa: ${last.stage}.`
      : "Verificando MCP, OAuth, endpoint e aguardando o próximo cliente."
  }) + "\n\n";
  for (const response of mcpMonitorListeners) {
    try { response.write(payload); } catch { mcpMonitorListeners.delete(response); }
  }
}, 1000);

type Claims = { iss:string; aud:string; sub:string; username?:string; scope?:string; iat:number; exp:number; __token?:string };
const READ_SECURITY = [{ type: "oauth2", scopes: ["aura.read"] }];
const EXECUTE_SECURITY = [{ type: "oauth2", scopes: ["aura.execute"] }];
const resultSchema = z.object({ok:z.boolean(),status:z.number().int().optional(),result:z.unknown().optional(),traceId:z.string().optional(),requestId:z.string().optional(),reason:z.string().optional()});
function b64(value:string|Buffer){return Buffer.from(value).toString("base64url");}
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function token(req:Request){return String(req.headers.authorization??"").replace(/^Bearer\s+/i,"").trim();}
function verify(raw:string,scope?:string):Claims|null{if(!MCP_SECRET)return null;const p=raw.split(".");if(p.length!==3)return null;let h:any,c:Claims;try{h=JSON.parse(Buffer.from(p[0],"base64url").toString());c=JSON.parse(Buffer.from(p[1],"base64url").toString())}catch{return null}const sig=b64(crypto.createHmac("sha256",MCP_SECRET).update(`${p[0]}.${p[1]}`).digest());const now=Math.floor(Date.now()/1000),scopes=String(c.scope??"").split(/\s+/).filter(Boolean);if(h?.alg!=="HS256"||h?.typ!=="JWT"||!equal(sig,p[2])||c.iss!==OAUTH_ISSUER||c.aud!==RESOURCE_URL||!c.sub||c.exp<=now||c.iat>now+120)return null;if(scope&&!scopes.includes(scope))return null;return {...c,__token:raw};}
function challenge(res:Response,scope="aura.read"){res.setHeader("WWW-Authenticate",`Bearer resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource", scope="${scope}"`);}
function auth(req:Request,res:Response){const c=verify(token(req));if(!c){challenge(res);res.status(401).json({error:"unauthorized",error_description:"A valid OAuth access token is required."});return null}return c;}
async function local(path:string,options:RequestInit={}){const response=await fetch(`http://127.0.0.1:${PORT}${path}`,{...options,headers:{Accept:"application/json",...(options.headers??{})},signal:options.signal??AbortSignal.timeout(10000)});const text=await response.text();let result:any=null;try{result=text?JSON.parse(text):null}catch{result={raw:text}}return{ok:response.ok,status:response.status,result};}
function authError(scope:string){return{isError:true,content:[{type:"text" as const,text:`Authentication required for ${scope}.`}],_meta:{"mcp/www_authenticate":[`Bearer resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="The ${scope} scope is required."`]}};}
function serverFor(claims:Claims){const server=new McpServer({name:"aura-supreme-operator",version:"1.1.0"},{instructions:"Use read tools to inspect the Aura ecosystem before execution. Use execute_supreme_action only when the user explicitly requests an operation. Every action is routed through the existing Supreme Operator and retains trace/request correlation."});server.registerTool("get_profile",{title:"Get connected profile",description:"Return the profile represented by the authenticated Aura connection.",inputSchema:{},outputSchema:{id:z.string().min(1),name:z.string().optional(),nickname:z.string().optional()},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{"openai/profile":true,securitySchemes:READ_SECURITY}},async()=>{const p={id:claims.sub,...(claims.username?{name:claims.username,nickname:claims.username}:{})};return{structuredContent:p,content:[{type:"text",text:JSON.stringify(p)}]}});server.registerTool("get_universal_health",{title:"Get Universal Server health",description:"Inspect Universal Server health without changing state.",inputSchema:{},outputSchema:resultSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}},async()=>{const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();const r=await local("/api/healthz",{headers:{"x-trace-id":traceId,"x-request-id":requestId}});const o={ok:r.ok,status:r.status,result:r.result,traceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});server.registerTool("get_capabilities",{title:"Get Aura system capabilities",description:"Inspect capabilities exposed through Universal Server and the Supreme Operator.",inputSchema:{},outputSchema:resultSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}},async()=>{const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();const r=await local("/api/agent/capabilities",{headers:{"x-trace-id":traceId,"x-request-id":requestId,"x-aurora-operator-mode":"supreme"}});const o={ok:r.ok,status:r.status,result:r.result,traceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});server.registerTool("get_diagnostics",{title:"Get Aurora diagnostics",description:"Inspect Aurora correlation and diagnostic state without changing state.",inputSchema:{traceId:z.string().min(1).optional()},outputSchema:resultSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}},async({traceId})=>{const requestTraceId=crypto.randomUUID(),requestId=crypto.randomUUID(),path=traceId?`/api/diagnostics/aurora/${encodeURIComponent(traceId)}`:"/api/diagnostics/aurora";const r=await local(path,{headers:{"x-trace-id":requestTraceId,"x-request-id":requestId,"x-aurora-operator-mode":"supreme"}});const o={ok:r.ok,status:r.status,result:r.result,traceId:requestTraceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});server.registerTool("get_aurora_status",{title:"Get Aurora Agent status",description:"Check the deployed Aurora Agent health endpoint without changing state.",inputSchema:{},outputSchema:resultSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}},async()=>{const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();const r=await fetch(`${AURORA_AGENT_URL}/health`,{headers:{Accept:"application/json","x-trace-id":traceId,"x-request-id":requestId},signal:AbortSignal.timeout(10000)});const text=await r.text();let result:any=null;try{result=text?JSON.parse(text):null}catch{result={raw:text}}const o={ok:r.ok,status:r.status,result,traceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});server.registerTool("get_ecosystem_status",{title:"Get complete Aura ecosystem status",description:"Read-only health snapshot of Universal Server, Aurora Agent, and the delegated Aura System bridge. Use this before troubleshooting or executing changes.",inputSchema:{},outputSchema:z.object({ok:z.boolean(),timestamp:z.string(),universal:z.unknown(),aurora:z.unknown(),aura:z.unknown()}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}},async()=>{const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();const [u,a]=await Promise.all([local("/api/healthz",{headers:{"x-trace-id":traceId,"x-request-id":requestId}}),fetch(`${AURORA_AGENT_URL}/health`,{headers:{Accept:"application/json","x-trace-id":traceId,"x-request-id":requestId},signal:AbortSignal.timeout(10000)}).then(async r=>{const t=await r.text();let v:any=null;try{v=t?JSON.parse(t):null}catch{v={raw:t}}return{ok:r.ok,status:r.status,result:v}}).catch(e=>({ok:false,status:503,result:{error:e instanceof Error?e.message:"Aurora request failed"}}))]);const aura=await local("/api/agent/action",{method:"POST",headers:{"content-type":"application/json","x-trace-id":traceId,"x-request-id":requestId,"x-aurora-operator-mode":"supreme",authorization:`Bearer ${claims.__token}`},body:JSON.stringify({domain:"integratesystem",action:"status",args:{},operatorMode:"supreme",traceId,requestId})});const o={ok:u.ok&&a.ok&&aura.ok,timestamp:new Date().toISOString(),universal:u,aurora:a,aura:aura};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});
server.registerTool("get_connected_platforms",{title:"Get connected platforms",description:"Read-only list of platforms connected to the Universal Server Operator vault. Credential secrets are never returned.",inputSchema:{},outputSchema:z.object({ok:z.boolean(),enabled:z.boolean(),platforms:z.array(z.object({id:z.number(),platform:z.string(),label:z.string().optional(),endpoint:z.string().optional()}))}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},securitySchemes:READ_SECURITY,_meta:{securitySchemes:READ_SECURITY}},async()=>{const access=await getUnifiedOperatorAccess();const platforms=await listOperatorPlatforms();const o={ok:true,enabled:access.enabled,platforms};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});

server.registerTool("execute_connected_platform",{title:"Execute connected platform operation",description:"Execute an explicit user-requested operation against a platform registered in the Universal Server Operator vault. The platform credential remains inside Universal Server and is never returned.",inputSchema:{platform:z.string().min(1),method:z.enum(["GET","POST","PUT","PATCH","DELETE"]).default("GET"),path:z.string().default("/"),query:z.record(z.unknown()).optional(),body:z.unknown().optional()},outputSchema:z.object({ok:z.boolean(),executed:z.boolean(),status:z.number().int().optional(),platform:z.string().optional(),method:z.string().optional(),path:z.string().optional(),result:z.unknown().optional(),error:z.string().optional()}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true},securitySchemes:EXECUTE_SECURITY,_meta:{securitySchemes:EXECUTE_SECURITY}},async({platform,method,path,query,body})=>{if(!verify(claims.__token??"","aura.execute"))return authError("aura.execute");const access=await getUnifiedOperatorAccess();if(!access.enabled){const o={ok:false,executed:false,status:403,error:"Unified Operator access is disabled."};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}}const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();try{const o=await executeOperatorPlatformRequest({platform,method,path,query,body,traceId,requestId});return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}}catch(error){const o={ok:false,executed:false,status:503,error:error instanceof Error?error.message:"Platform operation failed"};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}}});

server.registerTool("execute_supreme_action",{title:"Execute a Supreme Operator action",description:"Execute an explicit user-requested Aura operation through the existing Supreme Operator. This may change system state.",inputSchema:{domain:z.string().min(1),action:z.string().min(1),args:z.record(z.unknown()).optional().default({})},outputSchema:z.object({ok:z.boolean(),executed:z.boolean().optional(),status:z.number().int().optional(),result:z.unknown().optional(),traceId:z.string(),requestId:z.string()}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false},securitySchemes:EXECUTE_SECURITY,_meta:{securitySchemes:EXECUTE_SECURITY}},async({domain,action,args})=>{if(!verify(claims.__token??"","aura.execute"))return authError("aura.execute");const traceId=crypto.randomUUID(),requestId=crypto.randomUUID();const r=await local("/api/supreme/tool",{method:"POST",headers:{"content-type":"application/json","x-trace-id":traceId,"x-request-id":requestId,"x-aurora-operator-mode":"supreme",authorization:`Bearer ${claims.__token}`},body:JSON.stringify({target:"agent",domain:domain.trim().toLowerCase(),action:action.trim().toLowerCase(),args:args??{},operatorMode:"supreme",traceId,requestId}),signal:AbortSignal.timeout(50000)});const o={ok:r.ok,executed:Boolean(r.result?.executed),status:r.status,result:r.result,traceId,requestId};return{structuredContent:o,content:[{type:"text",text:JSON.stringify(o)}]}});return server;}

router.get("/.well-known/oauth-protected-resource",(_req,res)=>{
  const started=Date.now();
  const body={resource:RESOURCE_URL,authorization_servers:[OAUTH_ISSUER],scopes_supported:["aura.read","aura.execute"],bearer_methods_supported:["header"],resource_documentation:RESOURCE_URL+"/mcp"};
  res.json(body);
  recordMcpEvent({stage:"protected-resource",method:"GET",path:"/.well-known/oauth-protected-resource",status:res.statusCode,durationMs:Date.now()-started,source:"client",userAgent:String(_req.headers["user-agent"]??"")});
});
router.get("/.well-known/oauth-protected-resource/mcp",(_req,res)=>{
  const started=Date.now();
  const body={resource:RESOURCE_URL+"/mcp",authorization_servers:[OAUTH_ISSUER],scopes_supported:["aura.read","aura.execute"],bearer_methods_supported:["header"],resource_documentation:RESOURCE_URL+"/mcp"};
  res.json(body);
  recordMcpEvent({stage:"protected-resource-mcp",method:"GET",path:"/.well-known/oauth-protected-resource/mcp",status:res.statusCode,durationMs:Date.now()-started,source:"client",userAgent:String(_req.headers["user-agent"]??"")});
});
router.all("/mcp",async(req:Request,res:Response)=>{
  const started=Date.now();
  if(req.method==="OPTIONS"){res.status(204).end();recordMcpEvent({stage:"mcp-options",method:req.method,path:req.path,status:res.statusCode,durationMs:Date.now()-started,...requestContext(req)});return}
  if(req.method!=="POST"){res.setHeader("Allow","POST, OPTIONS");res.status(405).json({error:"method_not_allowed"});recordMcpEvent({stage:"mcp-method-rejected",method:req.method,path:req.path,status:res.statusCode,durationMs:Date.now()-started,...requestContext(req),detail:"Método não permitido. O endpoint MCP aceita POST e OPTIONS."});return}
  const claims=auth(req,res);
  if(!claims){recordMcpEvent({stage:"mcp-unauthorized",method:req.method,path:req.path,status:res.statusCode,durationMs:Date.now()-started,...requestContext(req),detail:"Requisição sem token OAuth válido. O valor do token não é registrado."});return}
  const server=serverFor(claims);const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});try{await server.connect(transport);await transport.handleRequest(req,res,req.body)}catch(error){if(!res.headersSent)res.status(500).json({error:"mcp_request_failed",message:error instanceof Error?error.message:"MCP request failed"});recordMcpEvent({stage:"mcp-error",method:req.method,path:req.path,status:res.statusCode,durationMs:Date.now()-started,...requestContext(req),detail:error instanceof Error?error.message:"MCP request failed"});}
  finally{recordMcpEvent({stage:"mcp-request",method:req.method,path:req.path,status:res.statusCode,durationMs:Date.now()-started,...requestContext(req)});try{await transport.close()}catch{}try{await server.close()}catch{}}
});export default router;
