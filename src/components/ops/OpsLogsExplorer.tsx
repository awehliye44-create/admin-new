import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Search, RefreshCw, FileText } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

const LEVEL_COLORS: Record<string, string> = {
  debug: 'bg-muted text-muted-foreground',
  info: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  warn: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  error: 'bg-destructive/10 text-destructive border-destructive/30',
  fatal: 'bg-destructive text-destructive-foreground',
};

export function OpsLogsExplorer() {
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const queryClient = useQueryClient();

  const { data: logs, isLoading, error, refetch } = useQuery({
    queryKey: ['ops-logs', levelFilter, sourceFilter, search],
    queryFn: async () => {
      let query = supabase
        .from('ops_logs')
        .select('id, level, source, message, error_code, http_status, duration_ms, created_at')
        .order('created_at', { ascending: false })
        .limit(100);

      if (levelFilter !== 'all') query = query.eq('level', levelFilter);
      if (sourceFilter !== 'all') query = query.eq('source', sourceFilter);
      if (search) query = query.or(`message.ilike.%${search}%,error_code.ilike.%${search}%,source.ilike.%${search}%`);

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    staleTime: 10000,
  });

  const { data: sources } = useQuery({
    queryKey: ['ops-log-sources'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ops_logs')
        .select('source')
        .limit(500);
      if (error) throw error;
      return [...new Set((data || []).map((l: any) => l.source))].sort();
    },
  });

  if (error) {
    return (
      <Card className="mt-4">
        <CardContent className="pt-6">
          <QueryErrorState error={error} onRetry={() => refetch()} title="Failed to load logs" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Logs Explorer</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{logs?.length || 0} entries</span>
            <Button variant="ghost" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ['ops-logs'] })}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 mt-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search logs..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger className="w-[120px]"><SelectValue placeholder="Level" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="fatal">Fatal</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="Source" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sources</SelectItem>
              {(sources || []).map((s: string) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[600px] overflow-auto">
          {isLoading ? (
            <div className="space-y-0">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 border-b">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-5 w-14" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))}
            </div>
          ) : !logs || logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                <FileText className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">No logs found</p>
              <p className="text-xs text-muted-foreground mt-1">
                {search || levelFilter !== 'all' || sourceFilter !== 'all'
                  ? 'Try adjusting your search or filter criteria'
                  : 'Logs will appear here as system events are recorded'}
              </p>
            </div>
          ) : (
            logs.map((log: any) => (
              <div key={log.id} className="flex items-start gap-3 px-4 py-2.5 border-b last:border-0 hover:bg-accent/30 transition-colors text-sm font-mono">
                <span className="text-xs text-muted-foreground whitespace-nowrap pt-0.5">
                  {format(new Date(log.created_at), 'HH:mm:ss.SSS')}
                </span>
                <Badge variant="outline" className={cn('text-[10px] shrink-0', LEVEL_COLORS[log.level])}>
                  {log.level.toUpperCase()}
                </Badge>
                <span className="text-xs text-primary/80 shrink-0">[{log.source}]</span>
                <span className="flex-1 text-foreground break-all">{log.message}</span>
                {log.http_status && (
                  <Badge variant="secondary" className="text-[10px] shrink-0">{log.http_status}</Badge>
                )}
                {log.duration_ms != null && (
                  <span className="text-xs text-muted-foreground shrink-0">{log.duration_ms}ms</span>
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
