import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SpecGapsPanel, type SpecGap } from '../SpecGapsPanel';

const openGap: SpecGap = {
  id: 'gap-1',
  taskId: 'task-1',
  taskTitle: 'WA05 查詢作業',
  functionCode: 'WA05',
  category: 'logic_unclear',
  description: '刪除是否需要確認？',
  status: 'open',
  resolutionNote: null,
  createdAt: '2026-01-01T00:00:00Z',
  resolvedAt: null,
};

describe('SpecGapsPanel resolve flow（E1：必填裁決備註）', () => {
  const refetch = vi.fn().mockResolvedValue(undefined);
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    refetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderPanel() {
    return render(<SpecGapsPanel gaps={[openGap]} loading={false} error={false} refetch={refetch} />);
  }

  it('clicking 解決 opens a required note input instead of resolving immediately', () => {
    renderPanel();
    fireEvent.click(screen.getByText('解決'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/必填：具體裁決內容/)).toBeInTheDocument();
    // 空備註時確認按鈕 disabled
    expect(screen.getByText('確認解決')).toBeDisabled();
  });

  it('sends resolutionNote in the POST body and refetches on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    renderPanel();

    fireEvent.click(screen.getByText('解決'));
    fireEvent.change(screen.getByPlaceholderText(/必填：具體裁決內容/), {
      target: { value: '選 B：刪除前 confirm 彈窗' },
    });
    fireEvent.click(screen.getByText('確認解決'));

    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spec-gaps/gap-1/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ resolutionNote: '選 B：刪除前 confirm 彈窗' }),
      }),
    );
  });

  it('shows the server validation error message on 400', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'resolutionNote 過於空泛（「可以」）——請寫「具體的決定內容」' }),
    });
    renderPanel();

    fireEvent.click(screen.getByText('解決'));
    fireEvent.change(screen.getByPlaceholderText(/必填：具體裁決內容/), { target: { value: '可以啦沒問題' } });
    fireEvent.click(screen.getByText('確認解決'));

    // toast store 收到錯誤訊息（面板仍在編輯狀態，不 refetch）
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(refetch).not.toHaveBeenCalled();
    const { useToastStore } = await import('../../../stores/toastStore');
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some(t => t.type === 'error' && (t.message ?? '').includes('過於空泛'))).toBe(true);
    });
  });
});
