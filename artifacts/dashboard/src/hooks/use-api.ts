import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export function useApiAuth() {
  const [password, setPasswordState] = useState<string>(() => {
    return sessionStorage.getItem('dashboard-key') || '';
  });

  const setPassword = useCallback((newPassword: string) => {
    setPasswordState(newPassword);
    if (newPassword) {
      sessionStorage.setItem('dashboard-key', newPassword);
    } else {
      sessionStorage.removeItem('dashboard-key');
    }
  }, []);

  const login = async (pass: string) => {
    const res = await fetch('/api/dashboard/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass }),
    });
    
    if (!res.ok) {
      throw new Error('Invalid password');
    }
    
    setPassword(pass);
    return true;
  };

  const logout = useCallback(() => {
    setPassword('');
  }, [setPassword]);

  return { password, login, logout, isAuthenticated: !!password };
}

export function useApi(password: string) {
  const queryClient = useQueryClient();

  const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set('x-dashboard-key', password);
    
    const res = await fetch(url, {
      ...options,
      headers,
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ error: 'An error occurred' }));
      throw new Error(errorData.error || `HTTP error ${res.status}`);
    }
    
    return res.json();
  };

  const useProjects = () => {
    return useQuery({
      queryKey: ['projects'],
      queryFn: () => fetchWithAuth('/api/dashboard/projects'),
      enabled: !!password,
    });
  };

  const useStats = () => {
    return useQuery({
      queryKey: ['stats'],
      queryFn: () => fetchWithAuth('/api/dashboard/stats'),
      enabled: !!password,
      refetchInterval: 10000,
    });
  };

  const useCreateProject = () => {
    return useMutation({
      mutationFn: (data: { name: string; description?: string }) => 
        fetchWithAuth('/api/dashboard/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['projects'] });
        queryClient.invalidateQueries({ queryKey: ['stats'] });
      },
    });
  };

  const useDeleteProject = () => {
    return useMutation({
      mutationFn: (id: number) => 
        fetchWithAuth(`/api/dashboard/projects/${id}`, {
          method: 'DELETE',
        }),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['projects'] });
        queryClient.invalidateQueries({ queryKey: ['stats'] });
      },
    });
  };

  return {
    useProjects,
    useStats,
    useCreateProject,
    useDeleteProject,
  };
}
