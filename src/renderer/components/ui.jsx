import * as React from "react";
import "../styles/inspector-refresh.css";
import { createPortal } from "react-dom";
import { PointerDrag } from "../hooks/usePointerDrag";
import { committedDraftValue } from "../lib/numericDraft";
import { PM } from "../lib/pathMath";
import { UnitPrefs, formatAngularLimit } from "../lib/unitPreferences";

// Bordeaux shared UI primitives.
  const { useState, useRef, useEffect, useId } = React;
  const h = React.createElement;

  const PATHS = {
    select: 'M5 3l6 14 2-6 6-2z',
    waypoint: 'M12 4v4M12 16v4M4 12h4M16 12h4',
    rotation: 'M5 12a7 7 0 1 1 2.5 5.3 M5 17v-4h4',
    marker: 'M6 4v16 M6 4h11l-2.5 4L17 12H6',
    play: 'M7 4l13 8-13 8z',
    pause: 'M8 5v14M16 5v14',
    rewind: 'M7 5v14 M19 5l-9 7 9 7z',
    grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
    flip: 'M4 8h16l-3-3 M20 16H4l3 3',
    undo: 'M9 7L4 12l5 5 M4 12h11a5 5 0 0 1 0 10h-1',
    redo: 'M15 7l5 5-5 5 M20 12H9a5 5 0 0 0 0 10h1',
    trash: 'M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1-13',
    plus: 'M12 5v14M5 12h14',
    chevron: 'M8 10l4 4 4-4',
    gear: 'M9.5 3h5l.6 2.3 1.8 1 2.3-.6 2.5 4.3-1.7 1.7v2.1l1.7 1.7-2.5 4.3-2.3-.6-1.8 1-.6 2.3h-5l-.6-2.3-1.8-1-2.3.6L1.8 15l1.7-1.7v-2.1L1.8 9.5l2.5-4.3 2.3.6 1.8-1L9.5 3z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v9H5z',
    route: 'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M9 16h6a3 3 0 0 0 3-3',
    flag2: 'M5 21V4 M5 4h13l-3 5 3 5H5',
    target: 'M12 3v3M12 18v3M3 12h3M18 12h3 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    gauge: 'M4 18a8 8 0 1 1 16 0 M12 14l4-4',
    start: 'M5 4v16 M5 5h10l-2 3 2 3H5',
    share: 'M12 15V4 M8 8l4-4 4 4 M5 14v5h14v-5',
    zoomin: 'M11 7v8M7 11h8 M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M16 16l5 5',
    zoomout: 'M7 11h8 M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M16 16l5 5',
    fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
    copy: 'M9 9h10v10H9z M5 15H4V4h11v1',
    edit: 'M4 20h4l11-11-4-4L4 16v4z M13.5 6.5l4 4',
    folder: 'M3 6h7l2 2h9v11H3z',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M16 16l5 5',
    refresh: 'M20 7v5h-5 M4 17v-5h5 M18.5 10a7 7 0 0 0-12-3L4 10 M5.5 14a7 7 0 0 0 12 3l2.5-3',
    zones: 'M4 12h16 M4 7h16 M4 17h16',
    car: 'M5 6h14v12H5z M9 6V4h6v2',
    info: 'M12 8h.01 M11 12h1v5h1 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    swerve: 'M12 3v18 M3 12h18 M12 12a4 4 0 1 0 0-.01 M12 5l2 2-2 2-2-2z',
    tank: 'M6 8h12v8H6z M4 8v8 M20 8v8 M9 8V6h6v2',
    stop: 'M8 8h8v8H8z',
    palette: 'M12 3a9 9 0 1 0 0 18 2 2 0 0 0 1.6-3.2 2 2 0 0 1 1.6-3.2H17a4 4 0 0 0 4-4 9 9 0 0 0-9-7.6z M7.5 12.5h.01 M9.5 8.5h.01 M14.5 8.5h.01',
    x: 'M6 6l12 12M18 6L6 18',
    compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M15.5 8.5l-2 5-5 2 2-5z',
    drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
    shuffle: 'M4 5h4l9 14h3 M17 5h3 M4 19h4l3-4.5 M15.5 7.5L20 5l-2 4 M18 22l2-3-3-1',
    branch: 'M6 4v6a4 4 0 0 0 4 4h4 M18 4v6a4 4 0 0 1-4 4 M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    dot: 'M12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    check: 'M5 13l4 4L19 7',
    bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
    layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
    pin: 'M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z M12 9a2 2 0 1 0 0 0z',
    ruler: 'M4 14L14 4l6 6L10 20z M8 10l2 2M11 7l2 2M14 10l2 2',
    sliders: 'M4 6h5M15 6h5M9 3v6M4 12h9M19 12h1M13 9v6M4 18h3M13 18h7M7 15v6',
  };

  function Icon({ name, size = 18, fill = false, stroke = 'currentColor', sw = 1.7 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false, fill: fill ? 'currentColor' : 'none', stroke: fill ? 'none' : stroke, strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: PATHS[name] || '' }));
  }

  function IconBtn({ icon, active, onClick, title, label, danger, disabled, size = 18, fill }) {
    return h('button', { className: 'iconbtn' + (active ? ' active' : '') + (danger ? ' danger' : ''), onClick, title, 'aria-label': label || title, 'aria-pressed': active == null ? undefined : active, disabled, type: 'button' }, h(Icon, { name: icon, size, fill }));
  }

  const MAX_RENDERED_PICKER_ITEMS = 80;
  const chosen = (result) => typeof result === 'string' ? { status: result } : result || {};
  /**
   * An opted-in choice's delayed return focus belongs to the chooser instance and result that scheduled it. `root`
   * is pinned before the owner runs; focus follows only if that root is still this chooser's, the owner still
   * reports the result current, and nothing has claimed focus since the owner returned, in this chooser or not.
   */
  const focusAfterChoice = ({ current }, rootRef, root, owners, target) => {
    const at = document.activeElement, from = owners.some((owner) => owner?.contains(at)) ? at : null;
    let claimed = false;
    const claim = () => { claimed = true; };
    document.addEventListener('focusin', claim, true);
    requestAnimationFrame(() => {
      document.removeEventListener('focusin', claim, true);
      const active = document.activeElement;
      const element = !claimed && root?.isConnected && rootRef.current === root && (!current || current()) && target();
      if (element?.isConnected && root.contains(element) && (!active || active === document.body || active === from)
        && !document.querySelector('dialog:modal,[role="dialog"][aria-modal="true"]')) element.focus();
    });
  };

  /**
   * `onChoose(value)` is an opt-in alternative to `onChange` for owners that may refuse: it returns
   * 'applied', 'unchanged' or 'refused', or `{ status, current }` whose `current()` says the result still owns
   * this chooser. Only 'refused' keeps the panel and leaves focus to the owner.
   * `defaultOpen` opens the chooser at mount only. `activateFirstMatch` makes typing activate the first match while an
   * empty query or an unlisted value activates nothing, so a bare or held Enter never picks.
   */
  function Dropdown({ id, label, ariaLabel, value, items = [], onChange, onChoose, disabled, placeholder, icon, searchThreshold = 7,
    compact = false, className = '', allowCustom = false, customLabel = 'Enter exact value', customPlaceholder = 'Exact runtime value', defaultOpen, activateFirstMatch }) {
    const [open, setOpen] = useState(() => Boolean(defaultOpen) && !disabled);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const [customDraft, setCustomDraft] = useState('');
    const rootRef = useRef(null);
    const triggerRef = useRef(null);
    const panelRef = useRef(null);
    const searchRef = useRef(null);
    const optionRefs = useRef([]);
    const customRef = useRef(null);
    const typeahead = useRef({ text: '', time: 0 });
    const [panelStyle, setPanelStyle] = useState(null);
    const listboxId = id + '-listbox';
    const labelId = id + '-label';
    const pickerName = label || ariaLabel || 'options';
    const selected = items.find((item) => item.value === value);
    const displayLabel = selected?.label ?? (value != null && value !== '' ? String(value) : placeholder || 'Select…');
    const normalizedQuery = query.trim().toLowerCase();
    const filteredItems = normalizedQuery
      ? items.filter((item) => [item.label, item.meta, item.searchText].some((part) => String(part || '').toLowerCase().includes(normalizedQuery)))
      : items;
    const visibleItems = filteredItems.slice(0, MAX_RENDERED_PICKER_ITEMS);
    const hiddenMatchCount = filteredItems.length - visibleItems.length;
    const showSearch = items.length > searchThreshold;

    useEffect(() => {
      if (!open) return;
      const closeFromOutside = (event) => {
        if (rootRef.current && !rootRef.current.contains(event.target) && panelRef.current && !panelRef.current.contains(event.target)) setOpen(false);
      };
      const positionPanel = () => {
        const trigger = triggerRef.current;
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(window.innerWidth - 16, Math.max(rect.width, compact ? 180 : 240));
        const below = window.innerHeight - rect.bottom - 8;
        const above = rect.top - 8;
        const openAbove = below < 230 && above > below;
        const room = Math.max(0, (openAbove ? above : below) - 8);
        setPanelStyle({
          position: 'fixed',
          left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
          top: openAbove ? 'auto' : rect.bottom + 4,
          bottom: openAbove ? window.innerHeight - rect.top + 4 : 'auto',
          width,
          '--dropdown-room': room + 'px',
        });
      };
      positionPanel();
      document.addEventListener('pointerdown', closeFromOutside);
      document.addEventListener('focusin', closeFromOutside);
      window.addEventListener('resize', positionPanel);
      window.addEventListener('scroll', positionPanel, true);
      return () => {
        document.removeEventListener('pointerdown', closeFromOutside);
        document.removeEventListener('focusin', closeFromOutside);
        window.removeEventListener('resize', positionPanel);
        window.removeEventListener('scroll', positionPanel, true);
      };
    }, [open]);

    useEffect(() => {
      if (disabled) setOpen(false);
    }, [disabled]);

    useEffect(() => {
      if (!open) { setQuery(''); setCustomDraft(''); typeahead.current = { text: '', time: 0 }; return; }
      const found = visibleItems.findIndex((item) => item.value === value), selectedIndex = activateFirstMatch ? found : Math.max(0, found);
      setActiveIndex(selectedIndex);
      const frame = requestAnimationFrame(() => {
        if (showSearch) searchRef.current?.focus();
        else (optionRefs.current[selectedIndex] || customRef.current || panelRef.current)?.focus();
        optionRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
      });
      return () => cancelAnimationFrame(frame);
    }, [open, panelStyle !== null]);

    const choose = (nextValue) => {
      if (disabled) return;
      if (!onChoose) {
        onChange(nextValue);
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
        return;
      }
      const root = rootRef.current, trigger = triggerRef.current, panel = panelRef.current, result = chosen(onChoose(nextValue));
      if (result.status === 'refused') return;
      setOpen(false);
      focusAfterChoice(result, rootRef, root, [root, panel], () => trigger);
    };
    const focusOption = (nextIndex) => {
      if (!visibleItems.length) return;
      const wrapped = (nextIndex + visibleItems.length) % visibleItems.length;
      setActiveIndex(wrapped);
      // A searchable combobox keeps the caret in its input while navigating results.
      // Otherwise typing after an arrow key silently stops filtering the choices.
      if (showSearch && document.activeElement === searchRef.current) {
        optionRefs.current[wrapped]?.scrollIntoView({ block: 'nearest' });
      } else optionRefs.current[wrapped]?.focus();
    };
    const focusAfterTrigger = (backward) => {
      const focusable = Array.from(document.querySelectorAll('button, input, textarea, select, [href], [tabindex]'))
        .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]')
          && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && !panelRef.current?.contains(element));
      const index = focusable.indexOf(triggerRef.current);
      const next = focusable[index + (backward ? -1 : 1)];
      setOpen(false);
      requestAnimationFrame(() => (next || triggerRef.current)?.focus());
    };
    const handleKeyDown = (event) => {
      if (disabled) return;
      if (!open) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault();
          setOpen(true);
        }
        return;
      }
      if (activateFirstMatch && event.repeat && event.key === 'Enter') event.preventDefault();
      else if (event.key === 'Escape') {
        event.stopPropagation(); event.preventDefault();
        setOpen(false); triggerRef.current?.focus();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const customControls = Array.from(panelRef.current?.querySelectorAll('.cmd-picker-custom input, .cmd-picker-custom button:not(:disabled)') || []);
        const customIndex = customControls.indexOf(event.target);
        if (!event.shiftKey && customIndex < customControls.length - 1) customControls[customIndex + 1].focus();
        else if (event.shiftKey && customIndex > 0) customControls[customIndex - 1].focus();
        else if (event.shiftKey && customIndex === 0 && (searchRef.current || optionRefs.current[activeIndex])) {
          (searchRef.current || optionRefs.current[activeIndex]).focus();
        } else focusAfterTrigger(event.shiftKey);
      } else if (!event.target.closest('.cmd-picker-custom')) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          focusOption(activeIndex < 0 ? (event.key === 'ArrowDown' ? 0 : visibleItems.length - 1) : activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
        } else if ((event.key === 'Home' || event.key === 'End') && event.target !== searchRef.current) {
          event.preventDefault(); focusOption(event.key === 'Home' ? 0 : visibleItems.length - 1);
        } else if ((event.key === 'Enter' || (event.key === ' ' && event.target !== searchRef.current)) && visibleItems[activeIndex]) {
          event.preventDefault(); choose(visibleItems[activeIndex].value);
        } else if (!showSearch && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          const now = Date.now();
          const text = (now - typeahead.current.time < 700 ? typeahead.current.text : '') + event.key.toLocaleLowerCase();
          typeahead.current = { text, time: now };
          const prefix = [...text].every((char) => char === text[0]) ? text[0] : text;
          const nextIndex = visibleItems.findIndex((_, offset) => String(visibleItems[(activeIndex + 1 + offset) % visibleItems.length].label).toLocaleLowerCase().startsWith(prefix));
          if (nextIndex >= 0) focusOption(activeIndex + 1 + nextIndex);
        }
      }
    };

    const panel = open && panelStyle && createPortal(h('div', { ref: panelRef, tabIndex: -1, className: 'cmd-picker-panel dropdown-panel', style: panelStyle, onKeyDown: (event) => { event.stopPropagation(); handleKeyDown(event); } },
      showSearch && h('div', { className: 'cmd-picker-search' }, h(Icon, { name: 'search', size: 14 }),
        h('label', { className: 'sr-only', htmlFor: id + '-search' }, 'Filter ' + pickerName.toLowerCase()),
        h('input', { id: id + '-search', ref: searchRef, type: 'search', value: query,
          placeholder: 'Filter ' + pickerName.toLowerCase() + '…', autoComplete: 'off', spellCheck: false,
          'data-lpignore': 'true', 'data-1p-ignore': true, 'aria-controls': listboxId,
          role: 'combobox', 'aria-expanded': true, 'aria-autocomplete': 'list',
          'aria-activedescendant': visibleItems[activeIndex] ? listboxId + '-option-' + activeIndex : undefined,
          onChange: (event) => { setQuery(event.target.value); setActiveIndex(activateFirstMatch && event.target.value.trim() ? 0 : -1); } })),
      h('div', { id: listboxId, className: 'cmd-picker-list', role: 'listbox', 'aria-labelledby': label ? labelId : undefined, 'aria-label': label ? undefined : pickerName },
        visibleItems.length === 0 ? h('div', { className: 'cmd-picker-empty', role: 'status' }, items.length ? 'No matches' : 'No choices available')
          : visibleItems.map((item, index) => h('button', { key: item.value,
              id: listboxId + '-option-' + index,
              ref: (node) => { optionRefs.current[index] = node; },
              className: 'cmd-picker-option' + (index === activeIndex ? ' active' : ''), type: 'button',
              role: 'option', tabIndex: -1, 'aria-selected': item.value === value, 'data-value': item.value,
              onFocus: () => setActiveIndex(index), onMouseEnter: () => { if (showSearch) setActiveIndex(index); }, onClick: () => choose(item.value) },
            h('span', { className: 'cmd-picker-check' }, item.value === value && h(Icon, { name: 'check', size: 13 })),
            h('span', { className: 'cmd-picker-option-copy' }, h('strong', { title: item.label }, item.label), item.meta && h('small', null, item.meta)),
            item.badge && h('span', { className: 'cmd-picker-badge', title: item.badge }, item.badge))),
        hiddenMatchCount > 0 && h('div', { className: 'cmd-picker-more', role: 'status' },
          visibleItems.length + ' of ' + filteredItems.length + ' shown. Keep typing to narrow results')),
      allowCustom && h('form', { className: 'cmd-picker-custom', onSubmit: (event) => {
        event.preventDefault();
        const exactValue = customDraft.trim();
        if (exactValue) choose(exactValue);
      } },
        h('label', { className: 'sr-only', htmlFor: id + '-custom' }, customLabel),
        h('input', { id: id + '-custom', ref: customRef, value: customDraft, placeholder: customPlaceholder,
          autoComplete: 'off', spellCheck: false, 'aria-label': customLabel,
          onKeyDown: (event) => { if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation(); },
          onChange: (event) => setCustomDraft(event.target.value) }),
        h('button', { type: 'submit', disabled: customDraft.trim().length === 0 }, 'Use'))), document.body);

    return h('div', { className: 'cmd-picker dropdown' + (compact ? ' compact' : '') + (className ? ' ' + className : ''), ref: rootRef, onKeyDown: handleKeyDown },
      label && h('span', { id: labelId, className: 'fieldlabel' }, label),
      h('button', { id, ref: triggerRef, className: 'cmd-picker-trigger', type: 'button', role: 'combobox',
        'aria-labelledby': label ? labelId + ' ' + id + '-value' : undefined, 'aria-label': label ? undefined : pickerName,
        'aria-controls': listboxId, 'aria-expanded': open,
        'aria-haspopup': 'listbox', disabled, onClick: () => setOpen((current) => !current) },
        icon && h(Icon, { name: icon, size: 14 }),
        h('span', { id: id + '-value', title: displayLabel }, displayLabel),
        selected && selected.badge && h('small', null, selected.badge),
        h(Icon, { name: 'chevron', size: 13 })),
      panel);
  }

  // Inline choice browser keeps discovery and parameters in one stable inspector.
  // `onChoose` follows Dropdown's opt-in contract; a refusal keeps the list and its query. `note` describes the
  // consequence of choosing, shown only while the choices are.
  function ChoiceBrowser({ id, label, value, items = [], onChange, onChoose, note, disabled, placeholder = 'Search', emptyText = 'No choices available', actionLabel = 'Change', resetKey }) {
    const [editing, setEditing] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(-1);
    const rootRef = useRef(null);
    const searchRef = useRef(null);
    const changeRef = useRef(null);
    const optionRefs = useRef([]);
    const selected = items.find((item) => item.value === value && value !== '');
    const expanded = editing || !selected;
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = items.filter((item) => terms.every((term) => [item.label, item.meta, item.searchText].join(' ').toLocaleLowerCase().includes(term)));
    const visible = matches.slice(0, MAX_RENDERED_PICKER_ITEMS);
    useEffect(() => { setEditing(false); setQuery(''); setActive(-1); }, [resetKey]);
    useEffect(() => { if (editing) searchRef.current?.focus(); }, [editing]);
    const choose = (item) => {
      if (!onChoose) {
        onChange(item.value); setEditing(false); setQuery(''); setActive(-1);
        requestAnimationFrame(() => (item.value ? changeRef.current : searchRef.current)?.focus());
        return;
      }
      const root = rootRef.current, result = chosen(onChoose(item.value));
      if (result.status === 'refused') return;
      setEditing(false); setQuery(''); setActive(-1);
      focusAfterChoice(result, rootRef, root, [root], () => item.value ? changeRef.current : searchRef.current);
    };
    const move = (index) => {
      if (!visible.length) return;
      const next = (index + visible.length) % visible.length;
      setActive(next); optionRefs.current[next]?.scrollIntoView({ block: 'nearest' });
    };
    return h('section', { ref: rootRef, className: 'choice-browser', 'aria-label': label, onKeyDown: (event) => {
      if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); if (selected) { setEditing(false); requestAnimationFrame(() => changeRef.current?.focus()); } else { setQuery(''); setActive(-1); searchRef.current?.focus(); } }
      if (event.target.getAttribute('role') === 'option' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); const index = optionRefs.current.indexOf(event.target); const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length; move(next); optionRefs.current[next]?.focus();
      }
    } },
      h('div', { className: 'choice-browser-heading' }, h('span', { className: 'fieldlabel' }, label),
        selected && h('button', { type: 'button', className: 'choice-change', ref: changeRef, disabled,
          'aria-expanded': expanded, 'aria-controls': id + '-choices', onClick: () => setEditing(!editing) }, expanded ? 'Done' : actionLabel)),
      expanded && note && h('p', { id: id + '-note', className: 'seg-hint' }, note),
      selected && !expanded && h('div', { className: 'choice-current' },
        h(Icon, { name: 'check', size: 15 }),
        h('div', null, h('strong', null, selected.label), selected.meta && h('small', null, selected.meta))),
      expanded && h('div', { id: id + '-choices', className: 'choice-browser-body' },
        h('div', { className: 'choice-search' }, h(Icon, { name: 'search', size: 15 }),
          h('input', { id, ref: searchRef, type: 'search', role: 'combobox', value: query, disabled,
            placeholder, 'aria-label': 'Search ' + label.toLowerCase(), 'aria-expanded': true, 'aria-describedby': note ? id + '-note' : undefined,
            'aria-controls': id + '-results', 'aria-autocomplete': 'list',
            'aria-activedescendant': active >= 0 && visible[active] ? id + '-result-' + active : undefined,
            onChange: (event) => { setQuery(event.target.value); setActive(-1); },
            onKeyDown: (event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); move(active < 0 ? (event.key === 'ArrowDown' ? 0 : visible.length - 1) : active + (event.key === 'ArrowDown' ? 1 : -1)); }
              if (event.key === 'Enter' && active >= 0 && visible[active]) { event.preventDefault(); event.stopPropagation(); choose(visible[active]); }
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (query) { setQuery(''); setActive(-1); } else if (selected) { setEditing(false); requestAnimationFrame(() => changeRef.current?.focus()); } }
            } })),
        h('div', { className: 'choice-results', id: id + '-results', role: 'listbox', 'aria-label': label },
          visible.map((item, index) => h('button', { key: item.value, id: id + '-result-' + index,
            ref: (node) => { optionRefs.current[index] = node; }, type: 'button', role: 'option', disabled, tabIndex: index === Math.max(0, active) ? 0 : -1,
            'aria-selected': item.value === value, className: 'choice-result' + (active === index ? ' active' : ''),
            onFocus: () => setActive(index), onClick: () => choose(item) },
            h('span', null, h('strong', null, item.label), item.meta && h('small', null, item.meta)),
            item.value === value && h(Icon, { name: 'check', size: 14 }))),
          visible.length === 0 && h('p', { className: 'choice-empty', role: 'status' }, query ? 'No matches. Try another name.' : emptyText)),
        matches.length > visible.length && h('p', { className: 'choice-empty' }, 'Search to narrow ' + matches.length + ' results.')));
  }

  // numeric field with drag-to-scrub
  function Num({ label, value, onChange, unit, imperialUnit, step = 0.01, min, max, precision = 2, format = (number) => number.toFixed(precision), projectDraft = true }) {
    const id = useId();
    const [edit, setEdit] = useState(null);
    const [scrub, setScrub] = useState(null);
    const [error, setError] = useState('');
    const cancelEdit = useRef(false);
    const scrubbing = useRef(false);
    const latest = useRef(value); latest.current = value;
    // Without a draft the field shows rounded text; committing that text would change the stored value.
    const draft = useRef(edit); draft.current = edit;
    const ref = useRef(null);
    const pointerDrag = PointerDrag.useController();
    const unitSystem = UnitPrefs.current();
    useEffect(() => {
      setEdit(null);
      setError('');
    }, [unitSystem]);
    /** Commits a text draft; returns the stored value, or null when it is invalid. */
    const resolveEdit = (raw) => {
      const next = committedDraftValue(raw, value, displayValue, (parsed) => UnitPrefs.toCanonical(parsed, unit, imperialUnit), { min, max });
      if (next == null) { setError('Enter a finite number.'); return null; }
      setError('');
      if (!Object.is(next, value)) onChange(next);
      return next;
    };
    const commitEdit = (raw) => resolveEdit(raw) != null;
    // A scrub previews its value in the field and commits once on release, so
    // one gesture is one edit. Escape, pointer cancellation, or window blur discards it.
    // A focused text draft commits as its blur would before the scrub replaces it;
    // afterward the field shows the stored value, so a later blur or save adds nothing.
    const start = () => (down) => {
      if (down.button !== 0 || ref.current?.matches(':disabled')) return;
      down.preventDefault();
      let dragged = false, next = null, base = value;
      const sx = down.clientX, sens = step * 8;
      const focused = () => document.activeElement === ref.current;
      const finish = () => {
        scrubbing.current = false; window.removeEventListener('keydown', onKey, true); setScrub(null);
        if (dragged) { cancelEdit.current = true; setEdit(null); }
      };
      const onKey = (event) => { if (event.key !== 'Escape') return; event.preventDefault(); event.stopPropagation(); pointerDrag.cancel({ flush: false }); };
      const mv = (e) => {
        if (!dragged) {
          if (Math.abs(e.clientX - sx) < 4) return;
          if (focused() && draft.current != null) { base = resolveEdit(ref.current.value); if (base == null) { pointerDrag.cancel({ flush: false }); return; } }
          else base = latest.current; // Blur committed any earlier draft, or the field shows the stored value.
          dragged = scrubbing.current = true;
        }
        let nv = (typeof base === 'number' ? base : 0) + (e.clientX - sx) * sens; if (min != null) nv = Math.max(min, nv); if (max != null) nv = Math.min(max, nv);
        next = Math.round(nv / step) * step; setScrub(next);
      };
      window.addEventListener('keydown', onKey, true);
      pointerDrag.start(down, { move: mv, cursor: 'ew-resize',
        end: () => {
          finish();
          if (!dragged) ref.current?.focus();
          else if (next != null && !Object.is(next, base)) onChange(next);
        },
        cancel: finish });
    };
    const displayValue = typeof value === 'number' ? UnitPrefs.fromCanonical(value, unit, imperialUnit) : value;
    const disp = scrub != null ? format(UnitPrefs.fromCanonical(scrub, unit, imperialUnit))
      : edit != null ? edit : (typeof displayValue === 'number' ? format(displayValue) : displayValue);
    return h('div', { className: 'numrow' },
      label != null && h('label', { className: 'numlbl', htmlFor: id, onPointerDown: start() }, label),
      h('div', { className: 'numbox' },
        h('input', {
          id, ref, className: 'numinput', value: disp, inputMode: 'decimal', 'aria-describedby': [unit && id + '-unit', error && id + '-error'].filter(Boolean).join(' ') || undefined,
          'data-project-draft': projectDraft ? true : undefined, 'aria-invalid': !!error,
          onChange: (e) => { cancelEdit.current = false; setEdit(e.target.value); if (error) setError(''); },
          onFocus: (e) => { cancelEdit.current = false; if (edit == null) setEdit(typeof displayValue === 'number' ? String(displayValue) : displayValue); requestAnimationFrame(() => { if (document.activeElement === e.target) e.target.select(); }); },
          // Tab during a scrub leaves the value to the scrub's release or cancellation.
          onBlur: (e) => { if (scrubbing.current) return; const committed = cancelEdit.current || edit == null || commitEdit(e.target.value); cancelEdit.current = false; if (committed) setEdit(null); },
          onKeyDown: (e) => {
            // Enter during a scrub, like Tab, leaves the value to its release or Escape.
            if (e.key === 'Enter') {
              e.preventDefault();
              if (!scrubbing.current && (cancelEdit.current || edit == null || commitEdit(e.target.value))) { cancelEdit.current = true; setEdit(null); e.target.blur(); }
            }
            if (e.key === 'Escape') {
              e.preventDefault(); e.stopPropagation(); cancelEdit.current = true; setError(''); setEdit(null);
              requestAnimationFrame(() => { if (document.activeElement === e.target) e.target.select(); });
            }
          },
        }),
        unit && h('span', { id: id + '-unit', className: 'numunit' }, UnitPrefs.label(unit, imperialUnit))),
      error && h('span', { id: id + '-error', className: 'cmd-param-error numerror', role: 'alert' }, error),
    );
  }

  /**
   * Authored text uses the same draft rules as Num: typing stays local, blur or
   * Enter commits one edit, and Escape restores the saved value. A draft
   * belongs to `owner`; when the owner changes, an uncommitted draft is dropped.
   */
  function DraftText({ value, onCommit, owner, ...props }) {
    const [draft, setDraft] = useState(null);
    const cancel = useRef(false);
    React.useLayoutEffect(() => { setDraft(null); }, [owner]);
    const commit = (raw) => { if (raw !== (value || '')) onCommit(raw); setDraft(null); };
    return h('input', { ...props, value: draft != null ? draft : (value || ''), 'data-project-draft': true,
      onFocus: () => { cancel.current = false; },
      onChange: (event) => { cancel.current = false; setDraft(event.target.value); },
      onBlur: (event) => { if (!cancel.current && draft != null) commit(event.target.value); cancel.current = false; },
      onKeyDown: (event) => {
        if (event.key === 'Enter') { event.preventDefault(); if (draft != null) commit(event.currentTarget.value); }
        else if (event.key === 'Escape' && draft != null) { event.preventDefault(); event.stopPropagation(); cancel.current = true; setDraft(null); }
      } });
  }

  function Section({ icon, title, count, right, children, open, onToggle, sub }) {
    return h('div', { className: 'section' + (open ? ' open' : '') },
      h('div', { className: 'sechead' },
        h('button', { className: 'sechead-toggle', type: 'button', onClick: onToggle, 'aria-expanded': open },
          h('span', { className: 'secchev' }, h(Icon, { name: 'chevron', size: 15 })),
          icon && h('span', { className: 'secicon' }, h(Icon, { name: icon, size: 16 })),
          h('span', { className: 'sectitle' }, title),
          sub && h('span', { className: 'secsub' }, sub),
          count != null && h('span', { className: 'seccount' }, count)),
        right),
      open && h('div', { className: 'secbody' }, children));
  }

  function Toggle({ on, onChange, label, ariaLabel }) {
    return h('button', { className: 'toggle' + (on ? ' on' : ''), onClick: () => onChange(!on), type: 'button', 'aria-label': ariaLabel || label || 'Toggle setting', 'aria-pressed': on },
      h('span', { className: 'toggle-track' }, h('span', { className: 'toggle-thumb' })),
      label && h('span', { className: 'toggle-lbl' }, label));
  }

  // The chosen option is raised on its own, so no shared indicator is needed.
  function Seg({ value, options, onChange, ariaLabel, className }) {
    return h('div', { className: 'seg' + (className ? ' ' + className : ''), role: 'group', 'aria-label': ariaLabel, style: { '--seg-count': Math.max(1, options.length) } },
      options.map(o => h('button', { key: o.v, type: 'button', disabled: Boolean(o.disabled), className: 'seg-i' + (value === o.v ? ' on' : ''), title: o.title, 'aria-description': o.title, 'aria-label': o.ariaLabel, 'aria-pressed': value === o.v, onClick: () => onChange(o.v) }, o.label)));
  }

  function constraintRangeSummary(range, constraints, robot) {
    const c = PM.effectiveConstraints(constraints || {}, robot);
    const velocityBase = Math.min(c.maxVel || Infinity, robot && robot.maxSpeed > 0 ? robot.maxSpeed : Infinity);
    const candidates = [
      { key: 'maxVel', base: velocityBase, order: 0, text: (v) => 'v \u2264 ' + UnitPrefs.format(v, 'm/s', 1), aria: (v) => 'maximum velocity ' + UnitPrefs.format(v, 'm/s', 1) },
      { key: 'maxAccel', base: c.maxAccel, order: 1, text: (v) => 'a \u2264 ' + UnitPrefs.format(v, 'm/s²', 1), aria: (v) => 'maximum acceleration ' + UnitPrefs.format(v, 'm/s²', 1) },
      { key: 'maxDecel', base: c.maxDecel != null ? c.maxDecel : c.maxAccel, order: 2, text: (v) => 'a \u2264 ' + UnitPrefs.format(v, 'm/s²', 1), aria: (v) => 'maximum acceleration ' + UnitPrefs.format(v, 'm/s²', 1) },
      { key: 'maxAngVel', base: c.maxAngVel, order: 3, text: (v) => '\u03c9 \u2264 ' + formatAngularLimit(v) + '\u00b0/s', aria: (v) => 'maximum angular velocity ' + formatAngularLimit(v) + ' degrees per second' },
      { key: 'maxAngAccel', base: c.maxAngAccel, order: 4, text: (v) => '\u03b1 \u2264 ' + formatAngularLimit(v) + '\u00b0/s\u00b2', aria: (v) => 'maximum angular acceleration ' + formatAngularLimit(v) + ' degrees per second squared' },
    ].filter((candidate) => {
      const value = range && range[candidate.key], baseline = candidate.base;
      return Number.isFinite(value) && value > 0 && Number.isFinite(baseline) && baseline > 0 && value < baseline - Math.max(1e-6, Math.abs(baseline) * 1e-6);
    }).map((candidate) => ({ ...candidate, value: range[candidate.key], ratio: range[candidate.key] / candidate.base }));
    candidates.sort((a, b) => a.ratio - b.ratio || a.order - b.order);
    const chosen = candidates[0];
    return chosen ? { text: chosen.text(chosen.value), ariaLabel: chosen.aria(chosen.value), key: chosen.key } : null;
  }

  // floating context menu — items: [{label,icon,onClick,danger,sep}]
  function ContextMenu({ x, y, items, onClose, returnFocus }) {
    const ref = useRef(null);
    const origin = useRef(returnFocus || null);
    const [pos, setPos] = useState({ x, y });
    useEffect(() => {
      const el = ref.current; if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
    }, [x, y]);
    useEffect(() => {
      const el = ref.current;
      if (!origin.current) origin.current = document.activeElement;
      el?.querySelector('button:not(:disabled)')?.focus();
      return () => {
        if (el?.contains(document.activeElement) && origin.current?.isConnected) origin.current.focus();
      };
    }, []);
    useEffect(() => {
      const close = () => {
        if (ref.current?.contains(document.activeElement) && origin.current?.isConnected) origin.current.focus();
        onClose();
      };
      const away = (event) => { if (ref.current && !ref.current.contains(event.target)) close(); };
      const key = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); close(); return;
        }
        if (!ref.current?.contains(event.target)) return;
        if (event.key === 'Tab') { close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const buttons = Array.from(ref.current.querySelectorAll('button:not(:disabled)'));
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      };
      window.addEventListener('pointerdown', away, true); window.addEventListener('keydown', key, true);
      return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key, true); };
    }, [onClose]);
    return h('div', { ref, role: 'menu', 'aria-label': 'Heading actions', className: 'ctxmenu', style: { left: pos.x + 'px', top: pos.y + 'px' } },
      items.map((it, i) => it.sep
        ? h('div', { key: 'sep' + i, role: 'separator', className: 'ctxmenu-sep' })
        : h('button', { key: i, type: 'button', role: 'menuitem', tabIndex: -1, disabled: it.disabled, className: 'ctxmenu-i' + (it.danger ? ' danger' : ''), onClick: () => {
            if (origin.current?.isConnected) origin.current.focus();
            onClose(); it.onClick();
          } },
            it.icon && h('span', { className: 'ctxmenu-ic' }, h(Icon, { name: it.icon, size: 14 })),
            h('span', null, it.label),
            it.hint && h('span', { className: 'ctxmenu-k' }, it.hint))));
  }

export const UI = { Icon, IconBtn, Dropdown, ChoiceBrowser, Num, DraftText, Section, Toggle, Seg, ContextMenu, constraintRangeSummary };
