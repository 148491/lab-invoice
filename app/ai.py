"""Rapprochement des noms par Claude (facultatif).

Activé seulement si la variable d'environnement ``ANTHROPIC_API_KEY`` est définie
sur le serveur. Sinon, l'algorithme local de ``names.py`` fait seul le travail.
Seuls des noms de personnes sont envoyés (jamais de montants).
"""
from __future__ import annotations

import json
import logging
import os

log = logging.getLogger(__name__)
MODEL = os.environ.get("FACTU_AI_MODEL", "claude-opus-5-5")

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


def enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def match_names(unknown: list[str], canonical: list[str]) -> dict[str, dict]:
    """Renvoie {nom inconnu: {match, confidence, reason}} ; {} si l'IA est indisponible."""
    if not enabled() or not unknown or not canonical:
        return {}
    try:
        import anthropic
    except ImportError:
        return {}
    prompt = (
        "Tu rapproches des noms de collaborateurs écrits de façon variable (export Jira, fichier de paie, "
        "saisie manuelle) avec la liste officielle des collaborateurs d'une entreprise.\n"
        "Pour chaque nom à rapprocher, indique le nom officiel correspondant s'il s'agit clairement de la même "
        "personne (fautes de frappe, ordre prénom/nom inversé, translittération hébreu/russe/français, initiale, "
        "identifiant de type prenom.nom ou e-mail). Si aucun nom officiel ne correspond, renvoie null : "
        "c'est probablement un nouveau collaborateur. Ne devine pas entre deux personnes plausibles.\n\n"
        f"Liste officielle :\n{json.dumps(canonical, ensure_ascii=False)}\n\n"
        f"Noms à rapprocher :\n{json.dumps(unknown, ensure_ascii=False)}"
    )
    try:
        client = anthropic.Anthropic()
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
            messages=[{"role": "user", "content": prompt}],
        )
        if resp.stop_reason == "refusal":
            return {}
        text = next(b.text for b in resp.content if b.type == "text")
        data = json.loads(text)
    except anthropic.APIStatusError as e:
        log.warning("IA indisponible (%s) : rapprochement local seulement", e.status_code)
        return {}
    except (anthropic.APIConnectionError, StopIteration, json.JSONDecodeError) as e:
        log.warning("IA indisponible (%s) : rapprochement local seulement", e)
        return {}
    allowed = set(canonical)
    out = {}
    for m in data.get("matches", []):
        if m.get("match") in allowed and m.get("input") in unknown:
            out[m["input"]] = {"name": m["match"], "score": float(m.get("confidence") or 0),
                               "reason": "IA : " + (m.get("reason") or "")}
    return out
