import { useCallback, useEffect, useState, type DependencyList } from 'react';
import { AdminApiError } from '../apiClient';

export type ResourceState<T> = {
  data?: T;
  loading: boolean;
  error: string;
  reload(): void;
  setData(next: T): void;
};

export function useResource<T>(loader: () => Promise<T>, dependencies: DependencyList): ResourceState<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    setLoading(true);
    setError('');
    void loader()
      .then(setData)
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setLoading(false));
  }, dependencies);
  useEffect(reload, [reload]);
  return { data, loading, error, reload, setData };
}

function messageOf(error: unknown) {
  return error instanceof AdminApiError || error instanceof Error ? error.message : '发生未知错误';
}
