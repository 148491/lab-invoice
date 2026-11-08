"""Rapprochement des noms par IA (facultatif).

Fournisseurs pris en charge, selon la clé définie sur le serveur :
* ``ANTHROPIC_API_KEY`` → Claude (modèle ``FACTU_AI_MODEL``, défaut claude-opus-5-5) ;
* ``OPENAI_API_KEY``    → OpenAI (modèle ``FACTU_OPENAI_MODEL``, défaut gpt-4o-mini).
Si les deux sont définies, ``FACTU_AI_PROVIDER`` (anthropic | openai) choisit ; sinon Claude.
Sans clé, l'algorithme local de ``names.py`` fait seul le travail.
Seuls des noms de personnes sont envoyés (jamais de montants).
"""
from __future__ import annotations

import json
import logging
import os

log = logging.getLogger(__name__)
MODEL = os.environ.get("FACTU_AI_MODEL", "claude-opus-5-5")
OPENAI_MODEL = os.environ.get("FACTU_OPENAI_MODEL", "gpt-4o-mini")
OPENAI_URL = os.environ.get("FACTU_OPENAI_URL", "https://api.openai.com/v1/chat/completions")

SCHEMA = {
    "type": "object",
    "properties": {
        "matches": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "input": {"type": "string"},
                    "match": {"type": ["string", "null"]},
                    "confidence": {"type": "number"},
                    "reason": {"type": "string"},
                },
                "required": ["input", "match", "confidence", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["matches"],
    "additionalProperties": False,
}


def provider() -> str | None:
    has_a, has_o = bool(os.environ.get("ANTHROPIC_API_KEY")), bool(os.environ.get("OPENAI_API_KEY"))
    choice = os.environ.get("FACTU_AI_PROVIDER", "").strip().lower()
    if choice == "openai" and has_o:
        return "openai"
    if choice == "anthropic" and has_a:
        return "anthropic"
    return "anthropic" if has_a else "openai" if has_o else None


def enabled() -> bool:
    return provider() is not None


def label() -> str:
    return {"anthropic": f"Claude ({MODEL})", "openai": f"OpenAI ({OPENAI_MODEL})"}.get(provider() or "", "")


def _prompt(unknown: list[str], canonical: list[str]) -> str:
    return (
        "Tu rapproches des noms de collaborateurs écrits de façon variable (export Jira, fichier de paie, "
        "saisie manuelle) avec la liste officielle des collaborateurs d'une entreprise.\n"
        "Pour chaque nom à rapprocher, indique le nom officiel correspondant s'il s'agit clairement de la même "
        "personne (fautes de frappe, ordre prénom/nom inversé, translittération hébreu/russe/français, initiale, "
        "identifiant de type prenom.nom ou e-mail). Si aucun nom officiel ne correspond, renvoie null : "
        "c'est probablement un nouveau collaborateur. Ne devine pas entre deux personnes plausibles.\n\n"
        f"Liste officielle :\n{json.dumps(canonical, ensure_ascii=False)}\n\n"
        f"Noms à rapprocher :\n{json.dumps(unknown, ensure_ascii=False)}"
    )


def _ask_anthropic(prompt: str) -> dict | None:
    try:
        import anthropic
    except ImportError:
        return None
    try:
        resp = anthropic.Anthropic().beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
            messages=[{"role": "user", "content": prompt}],
        )
        if resp.stop_reason == "refusal":
            return None
        return json.loads(next(b.text for b in resp.content if b.type == "text"))
    except anthropic.APIStatusError as e:
        log.warning("IA Claude indisponible (%s) : rapprochement local seulement", e.status_code)
    except (anthropic.APIConnectionError, StopIteration, json.JSONDecodeError) as e:
        log.warning("IA Claude indisponible (%s) : rapprochement local seulement", e)
    return None


def _ask_openai(prompt: str, transport=None) -> dict | None:
    import httpx
    body = {
        "model": OPENAI_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "rapprochement_noms", "strict": True, "schema": SCHEMA}},
    }
    try:
        with httpx.Client(timeout=60, transport=transport) as client:
            r = client.post(OPENAI_URL, json=body,
                            headers={"Authorization": f"Bearer {os.environ.get('OPENAI_API_KEY', '')}"})
        if r.status_code != 200:
            log.warning("IA OpenAI indisponible (%s) : rapprochement local seulement", r.status_code)
            return None
        msg = r.json()["choices"][0]["message"]
        if msg.get("refusal") or not msg.get("content"):
            return None
        return json.loads(msg["content"])
    except (httpx.HTTPError, KeyError, IndexError, json.JSONDecodeError) as e:
        log.warning("IA OpenAI indisponible (%s) : rapprochement local seulement", e)
        return None


def match_names(unknown: list[str], canonical: list[str], transport=None) -> dict[str, dict]:
    """Renvoie {nom inconnu: {name, score, reason}} ; {} si l'IA est indisponible."""
    p = provider()
    if not p or not unknown or not canonical:
        return {}
    prompt = _prompt(unknown, canonical)
    data = _ask_openai(prompt, transport) if p == "openai" else _ask_anthropic(prompt)
    if not data:
        return {}
    allowed = set(canonical)
    out = {}
    for m in data.get("matches", []):
        if m.get("match") in allowed and m.get("input") in unknown:
            out[m["input"]] = {"name": m["match"], "score": float(m.get("confidence") or 0),
                               "reason": "IA : " + (m.get("reason") or "")}
    return out
