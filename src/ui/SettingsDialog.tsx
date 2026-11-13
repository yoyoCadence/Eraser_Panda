import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_RULES } from '../core/rules';
import { LANG_LABEL, parseList, type LangKey, type Settings } from '../core/settings';

interface Props {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onSave: (s: Settings) => void;
}

export function SettingsDialog({ open, settings, onClose, onSave }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(settings);
  const [words, setWords] = useState(settings.customWords.join('\n'));
  const [regex, setRegex] = useState(settings.customRegex.join('\n'));
  const [regexError, setRegexError] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setDraft(settings);
      setWords(settings.customWords.join('\n'));
      setRegex(settings.customRegex.join('\n'));
      setRegexError('');
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, settings]);

  const save = () => {
    const re = parseList(regex, false);
    for (const r of re) {
      try {
        new RegExp(r, 'u');
      } catch (e) {
        setRegexError(`正規表示式錯誤：${r}（${(e as Error).message}）`);
        return;
      }
    }
    onSave({ ...draft, customWords: parseList(words, true), customRegex: re });
  };

  const langs = Object.keys(LANG_LABEL) as LangKey[];
  return (
    <dialog ref={ref} class="settings" onClose={onClose} onCancel={onClose} data-testid="settings-dialog">
      <form method="dialog" onSubmit={(e) => (e.preventDefault(), save())}>
        <h2>關鍵字設定</h2>

        <fieldset>
          <legend>內建分級字眼</legend>
          <div class="langs">
            {langs.map((l) => (
              <label key={l}>
                <input type="checkbox" checked={draft.languages[l]} onChange={(e) => setDraft({ ...draft, languages: { ...draft.languages, [l]: e.currentTarget.checked } })} />
                {LANG_LABEL[l]}（{DEFAULT_RULES.filter((r) => r.id.startsWith(`${l}:`)).length}）
              </label>
            ))}
          </div>
          <details>
            <summary>查看 / 停用個別字眼</summary>
            <div class="rule-list">
              {DEFAULT_RULES.map((r) => (
                <label key={r.id} class="rule-chip">
                  <input
                    type="checkbox"
                    checked={!draft.disabledRuleIds.includes(r.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        disabledRuleIds: e.currentTarget.checked ? draft.disabledRuleIds.filter((x) => x !== r.id) : [...draft.disabledRuleIds, r.id],
                      })
                    }
                  />
                  {r.pattern}
                </label>
              ))}
            </div>
          </details>
        </fieldset>

        <fieldset>
          <legend>自訂字眼（公司名稱、專案代號…）</legend>
          <p class="muted">每行一個（也可用逗號分隔）。不分大小寫、全形半形；英文以整字比對。</p>
          <textarea rows={5} value={words} onInput={(e) => setWords(e.currentTarget.value)} placeholder={'ACME Corp\n艾克米股份有限公司\nProject Apollo'} data-testid="custom-words" />
        </fieldset>

        <fieldset>
          <legend>進階：正規表示式</legend>
          <p class="muted">每行一個，例如文件編號 <code>DOC-\d{'{'}6{'}'}</code>。</p>
          <textarea rows={3} value={regex} onInput={(e) => setRegex(e.currentTarget.value)} spellcheck={false} />
          {regexError && <p class="error">{regexError}</p>}
        </fieldset>

        <p class="muted small">設定只儲存在這台電腦的瀏覽器中。</p>
        <div class="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" class="primary" data-testid="settings-save">
            儲存並重新掃描
          </button>
        </div>
      </form>
    </dialog>
  );
}
