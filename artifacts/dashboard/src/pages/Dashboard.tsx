import React, { useState, useEffect, useRef } from 'react';
import { useApiAuth, useApi } from '@/hooks/use-api';
import { useHealthCheck } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Copy, Plus, Server, Activity, Database, Key, Trash2, Code, Terminal, ChevronRight, LogOut, Check } from 'lucide-react';
import { format } from 'date-fns';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';

const projectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(50),
  description: z.string().max(255).optional(),
});

type ProjectFormValues = z.infer<typeof projectSchema>;

function LoginScreen({ onLogin }: { onLogin: (password: string) => Promise<boolean> }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    
    setLoading(true);
    setError('');
    
    try {
      await onLogin(password);
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
      toast({
        variant: 'destructive',
        title: 'Access Denied',
        description: 'The password provided is incorrect.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-primary/10 rounded-full blur-2xl pointer-events-none" />
      
      <div className="z-10 w-full max-w-md p-6">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-card border border-white/10 rounded-2xl flex items-center justify-center mb-6 shadow-2xl">
            <Server className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Universal Server</h1>
          <p className="text-sm text-muted-foreground mt-2">Enter your dashboard key to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Input
              type="password"
              placeholder="Dashboard Key"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-card/50 border-white/10 text-center font-mono tracking-widest h-12 focus-visible:ring-primary/50"
              autoFocus
            />
          </div>
          
          {error && <p className="text-sm text-destructive text-center">{error}</p>}
          
          <Button 
            type="submit" 
            className="w-full h-12 hover-elevate transition-all duration-300"
            disabled={!password || loading}
          >
            {loading ? <Terminal className="w-5 h-5 animate-pulse" /> : 'Authenticate'}
          </Button>
        </form>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, description, loading }: any) {
  return (
    <Card className="glass-panel overflow-hidden relative group">
      <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity duration-500">
        <Icon className="w-12 h-12" />
      </div>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-20 mb-1" />
        ) : (
          <div className="text-3xl font-bold font-mono text-foreground mb-1">{value}</div>
        )}
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function CopyableField({ value, label }: { value: string, label: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    toast({
      title: "Copied to clipboard",
      description: `${label} has been copied.`,
    });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div 
      className="flex items-center justify-between bg-black/40 border border-white/5 rounded-md p-2 cursor-pointer hover:bg-black/60 transition-colors group"
      onClick={onCopy}
    >
      <code className="text-xs text-primary font-mono truncate mr-2">{value}</code>
      <button className="text-muted-foreground group-hover:text-foreground transition-colors p-1">
        {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

function DashboardApp({ password, onLogout }: { password: string, onLogout: () => void }) {
  const { useProjects, useStats, useCreateProject, useDeleteProject } = useApi(password);
  const { data: projects, isLoading: loadingProjects } = useProjects();
  const { data: stats, isLoading: loadingStats } = useStats();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const { data: health, isLoading: loadingHealth, isError: healthError } = useHealthCheck();
  const { toast } = useToast();
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const originUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      name: '',
      description: '',
    },
  });

  const onSubmit = async (values: ProjectFormValues) => {
    try {
      await createProject.mutateAsync(values);
      setIsNewProjectOpen(false);
      form.reset();
      toast({
        title: "Project created",
        description: `Successfully created project ${values.name}`,
      });
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Error creating project',
        description: err.message || 'Something went wrong',
      });
    }
  };

  const handleDelete = async (id: number, name: string) => {
    try {
      await deleteProject.mutateAsync(id);
      toast({
        title: "Project deleted",
        description: `${name} has been removed.`,
      });
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Error deleting project',
        description: err.message || 'Something went wrong',
      });
    }
  };

  const copyOrigin = () => {
    navigator.clipboard.writeText(originUrl);
    toast({ title: "URL copied", description: "Server URL copied to clipboard" });
  };

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-8 h-8 bg-primary/20 text-primary rounded-lg flex items-center justify-center">
              <Server className="w-5 h-5" />
            </div>
            <h1 className="font-bold tracking-tight">Universal Server</h1>
            
            <div className="hidden sm:flex items-center ml-4 px-3 py-1 bg-white/5 border border-white/10 rounded-full cursor-pointer hover:bg-white/10 transition-colors" onClick={copyOrigin}>
              <span className="text-xs font-mono text-muted-foreground mr-2">{originUrl}</span>
              <Copy className="w-3 h-3 text-muted-foreground" />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-black/20 rounded-full border border-white/5">
              <div className={`w-2 h-2 rounded-full ${healthError ? 'bg-destructive' : 'bg-success animate-pulse-slow'}`} />
              <span className="text-xs font-medium text-muted-foreground">
                {loadingHealth ? 'Checking...' : healthError ? 'Offline' : 'Online'}
              </span>
            </div>
            
            <Button variant="ghost" size="icon" onClick={onLogout} className="text-muted-foreground hover:text-foreground">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <StatCard 
            title="Total Projects" 
            value={stats?.totalProjects ?? 0} 
            icon={Code} 
            description="Active API keys" 
            loading={loadingStats}
          />
          <StatCard 
            title="Requests Today" 
            value={stats?.requestsToday?.toLocaleString() ?? 0} 
            icon={Activity} 
            description="Across all endpoints" 
            loading={loadingStats}
          />
          <StatCard 
            title="Active Collections" 
            value={stats?.totalCollections ?? 0} 
            icon={Database} 
            description="Unique data stores" 
            loading={loadingStats}
          />
        </div>

        {/* Projects Section */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Projects</h2>
            <p className="text-sm text-muted-foreground">Manage your applications and API keys</p>
          </div>
          
          <Dialog open={isNewProjectOpen} onOpenChange={setIsNewProjectOpen}>
            <DialogTrigger asChild>
              <Button className="hover-elevate">
                <Plus className="w-4 h-4 mr-2" />
                New Project
              </Button>
            </DialogTrigger>
            <DialogContent className="glass-panel border-white/10 sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>Create Project</DialogTitle>
                <DialogDescription>
                  A new API key will be generated automatically.
                </DialogDescription>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project Name</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. My Next.js App" className="bg-black/20" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Description <span className="text-muted-foreground font-normal">(Optional)</span></FormLabel>
                        <FormControl>
                          <Input placeholder="What is this project for?" className="bg-black/20" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter className="pt-4">
                    <Button type="submit" disabled={createProject.isPending} className="w-full">
                      {createProject.isPending ? 'Creating...' : 'Create and generate key'}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>

        {loadingProjects ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 mb-16">
            {[1, 2, 3].map(i => (
              <Card key={i} className="glass-panel animate-pulse h-64" />
            ))}
          </div>
        ) : projects?.length === 0 ? (
          <div className="glass-panel border border-dashed border-white/10 rounded-xl p-12 flex flex-col items-center justify-center text-center mb-16">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <Key className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">No projects yet</h3>
            <p className="text-muted-foreground text-sm max-w-sm mb-6">
              Create a project to generate an API key and start storing data in your Universal Server.
            </p>
            <Button onClick={() => setIsNewProjectOpen(true)} variant="outline" className="hover-elevate">
              Create your first project
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-16">
            {projects?.map((project, i) => (
              <Card 
                key={project.id} 
                className="glass-panel border-white/5 animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both"
                style={{ animationDelay: `${i * 100}ms` }}
              >
                <CardHeader className="pb-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-lg font-medium">{project.name}</CardTitle>
                      <CardDescription className="mt-1 line-clamp-2 min-h-[40px]">
                        {project.description || 'No description'}
                      </CardDescription>
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 -mt-2 -mr-2">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="glass-panel border-white/10">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete Project?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently delete the project "{project.name}" and invalidate its API key. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="bg-transparent border-white/10">Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleDelete(project.id, project.name)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                            Delete Project
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">API Key</Label>
                    <CopyableField value={project.api_key} label="API Key" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">Example Usage URL</Label>
                    <div className="bg-black/40 border border-white/5 rounded-md p-2 flex items-center overflow-hidden">
                      <span className="text-xs text-muted-foreground whitespace-nowrap mr-1">{originUrl}/api/data/</span>
                      <span className="text-xs text-primary font-bold">your_collection</span>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="pt-2 border-t border-white/5 text-xs text-muted-foreground justify-between">
                  <span>ID: {project.id}</span>
                  <span>Created {format(new Date(project.created_at), 'MMM d, yyyy')}</span>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}

        {/* Documentation Panel */}
        <div className="mb-12 border-t border-white/10 pt-12">
          <div className="flex items-center gap-2 mb-6">
            <Terminal className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-bold tracking-tight">API Reference</h2>
          </div>
          
          <Card className="glass-panel border-white/5 p-0 overflow-hidden">
            <div className="p-6 bg-black/20 border-b border-white/5">
              <p className="text-sm text-muted-foreground">
                The Universal Server allows you to store and retrieve JSON data from arbitrary collections.
                Collections are created automatically when you first write to them.
                <br /><br />
                <strong>Important:</strong> All data endpoints require the <code className="text-primary font-mono bg-primary/10 px-1 py-0.5 rounded">x-api-key</code> header using a project's API key.
              </p>
            </div>
            
            <div className="divide-y divide-white/5">
              <DocRow method="GET" path="/api/data/:collection" desc="List all items in a collection" />
              <DocRow method="GET" path="/api/data/:collection/:id" desc="Get a specific item by ID" />
              <DocRow method="POST" path="/api/data/:collection" desc="Create a new item in a collection" />
              <DocRow method="PUT" path="/api/data/:collection/:id" desc="Update an existing item" />
              <DocRow method="DELETE" path="/api/data/:collection/:id" desc="Delete an item" />
              <DocRow method="GET" path="/api/healthz" desc="Server status and uptime (no auth required)" />
            </div>
            
            <div className="p-6 bg-black/40">
              <Label className="text-xs text-muted-foreground mb-2 block">cURL Example</Label>
              <pre className="bg-black/60 p-4 rounded-lg overflow-x-auto border border-white/5">
                <code className="text-sm font-mono text-muted-foreground">
                  <span className="text-blue-400">curl</span> -X POST {originUrl}/api/data/users \<br/>
                  &nbsp;&nbsp;-H <span className="text-green-400">"Content-Type: application/json"</span> \<br/>
                  &nbsp;&nbsp;-H <span className="text-green-400">"x-api-key: your_project_api_key"</span> \<br/>
                  &nbsp;&nbsp;-d <span className="text-yellow-400">'&#123;"name": "Alex", "role": "admin"&#125;'</span>
                </code>
              </pre>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}

function DocRow({ method, path, desc }: { method: string, path: string, desc: string }) {
  const methodColors: Record<string, string> = {
    GET: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
    POST: 'text-green-400 bg-green-400/10 border-green-400/20',
    PUT: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
    DELETE: 'text-red-400 bg-red-400/10 border-red-400/20',
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center p-4 hover:bg-white/5 transition-colors group">
      <div className="flex items-center min-w-[300px] mb-2 sm:mb-0">
        <span className={`text-xs font-mono font-bold px-2 py-1 rounded border ${methodColors[method]} w-16 text-center mr-3`}>
          {method}
        </span>
        <code className="text-sm font-mono text-foreground/80">{path}</code>
      </div>
      <div className="flex items-center text-sm text-muted-foreground">
        <ChevronRight className="w-4 h-4 mr-2 hidden sm:block opacity-30" />
        {desc}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { password, login, logout, isAuthenticated } = useApiAuth();

  if (!isAuthenticated) {
    return <LoginScreen onLogin={login} />;
  }

  return <DashboardApp password={password} onLogout={logout} />;
}
