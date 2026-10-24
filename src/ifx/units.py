import re

_ENTITY_FLAGS = re.IGNORECASE | re.DOTALL
_PREFIX_SYMBOLS = {
    "EXA": "E",
    "PETA": "P",
    "TERA": "T",
    "GIGA": "G",
    "MEGA": "M",
    "KILO": "k",
    "HECTO": "h",
    "DECA": "da",
    "DECI": "d",
    "CENTI": "c",
    "MILLI": "m",
    "MICRO": "µ",
    "NANO": "n",
    "PICO": "p",
    "FEMTO": "f",
    "ATTO": "a",
}
_SI_SYMBOLS = {
    "AMPERE": "A",
    "BECQUEREL": "Bq",
    "CANDELA": "cd",
    "COULOMB": "C",
    "CUBIC_METRE": "m³",
    "DEGREE_CELSIUS": "°C",
    "FARAD": "F",
    "GRAM": "g",
    "GRAY": "Gy",
    "HENRY": "H",
    "HERTZ": "Hz",
    "JOULE": "J",
    "KELVIN": "K",
    "LUMEN": "lm",
    "LUX": "lx",
    "METRE": "m",
    "MOLE": "mol",
    "NEWTON": "N",
    "OHM": "Ω",
    "PASCAL": "Pa",
    "RADIAN": "rad",
    "SECOND": "s",
    "SIEMENS": "S",
    "SIEVERT": "Sv",
    "SQUARE_METRE": "m²",
    "STERADIAN": "sr",
    "TESLA": "T",
    "VOLT": "V",
    "WATT": "W",
    "WEBER": "Wb",
}
_CONVERSION_SYMBOLS = {
    "DEGREE": "°",
    "DEGREES": "°",
    "FOOT": "ft",
    "FEET": "ft",
    "INCH": "in",
    "INCHES": "in",
    "LITRE": "L",
    "LITER": "L",
    "MILE": "mi",
    "YARD": "yd",
}


def extract_project_units(ifc_bytes: bytes) -> dict[str, str]:
    """Return IFC unit-type names mapped to compact display symbols."""

    text = ifc_bytes.decode("utf-8", errors="ignore")
    units: dict[int, tuple[str, str]] = {}

    for match in re.finditer(
        r"#\s*(\d+)\s*=\s*IFCSIUNIT\s*\(([^;]*)\)\s*;",
        text,
        _ENTITY_FLAGS,
    ):
        parsed = _parse_si_unit(match.group(2))
        if parsed:
            units[int(match.group(1))] = parsed

    for match in re.finditer(
        r"#\s*(\d+)\s*=\s*IFCCONVERSIONBASEDUNIT(?:WITHOFFSET)?\s*\(([^;]*)\)\s*;",
        text,
        _ENTITY_FLAGS,
    ):
        parsed = _parse_conversion_unit(match.group(2))
        if parsed:
            units[int(match.group(1))] = parsed

    for match in re.finditer(
        r"#\s*(\d+)\s*=\s*IFCMONETARYUNIT\s*\(\s*'([^']+)'\s*\)\s*;",
        text,
        _ENTITY_FLAGS,
    ):
        units[int(match.group(1))] = ("MONETARYUNIT", match.group(2).strip())

    assignments: dict[int, list[int]] = {}
    for match in re.finditer(
        r"#\s*(\d+)\s*=\s*IFCUNITASSIGNMENT\s*\(([^;]*)\)\s*;",
        text,
        _ENTITY_FLAGS,
    ):
        assignments[int(match.group(1))] = [
            int(reference) for reference in re.findall(r"#\s*(\d+)", match.group(2))
        ]

    assignment_id = _project_unit_assignment(text, assignments)
    if assignment_id is None:
        return {}
    return {
        unit_type: symbol
        for reference in assignments[assignment_id]
        if (parsed := units.get(reference))
        for unit_type, symbol in [parsed]
    }


def _parse_si_unit(arguments: str) -> tuple[str, str] | None:
    unit_type = _enum_argument(arguments, "UNIT")
    name_match = re.findall(r"\.([A-Z][A-Z0-9_]*)\.", arguments, re.IGNORECASE)
    if not unit_type or not name_match:
        return None
    name = name_match[-1].upper()
    symbol = _SI_SYMBOLS.get(name)
    if not symbol:
        return None
    prefix_match = re.search(
        r"\.([A-Z]+UNIT)\.\s*,\s*(?:\.([A-Z]+)\.|\$)\s*,",
        arguments,
        re.IGNORECASE,
    )
    prefix = prefix_match.group(2).upper() if prefix_match and prefix_match.group(2) else None
    if prefix and prefix in _PREFIX_SYMBOLS:
        symbol = _apply_prefix(symbol, _PREFIX_SYMBOLS[prefix])
    return unit_type, symbol


def _parse_conversion_unit(arguments: str) -> tuple[str, str] | None:
    unit_type = _enum_argument(arguments, "UNIT")
    name_match = re.search(r"'([^']+)'", arguments)
    if not unit_type or not name_match:
        return None
    name = name_match.group(1).strip()
    symbol = _CONVERSION_SYMBOLS.get(name.upper(), name)
    return unit_type, symbol


def _enum_argument(arguments: str, suffix: str) -> str | None:
    match = re.search(rf"\.([A-Z][A-Z0-9_]*{suffix})\.", arguments, re.IGNORECASE)
    return match.group(1).upper() if match else None


def _apply_prefix(symbol: str, prefix: str) -> str:
    if symbol == "m²":
        return f"{prefix}m²"
    if symbol == "m³":
        return f"{prefix}m³"
    return f"{prefix}{symbol}"


def _project_unit_assignment(text: str, assignments: dict[int, list[int]]) -> int | None:
    if not assignments:
        return None
    project = re.search(r"#\s*\d+\s*=\s*IFCPROJECT\s*\(([^;]*)\)\s*;", text, _ENTITY_FLAGS)
    if project:
        project_references = {
            int(reference) for reference in re.findall(r"#\s*(\d+)", project.group(1))
        }
        for assignment_id in assignments:
            if assignment_id in project_references:
                return assignment_id
    return next(reversed(assignments))
