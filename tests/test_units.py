from ifx.units import extract_project_units


def test_extracts_project_si_and_conversion_units():
    ifc = b"""ISO-10303-21;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#2=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#3=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#4=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#5=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#6=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.0174532925199433),#5);
#7=IFCCONVERSIONBASEDUNIT(
  #4,.PLANEANGLEUNIT.,'DEGREE',#6
);
#8=IFCMONETARYUNIT('USD');
#9=IFCUNITASSIGNMENT((#1,#2,#3,#7,#8));
#10=IFCPROJECT('guid',$,'Project',$,$,$,$,(#11),#9);
ENDSEC;
END-ISO-10303-21;
"""

    assert extract_project_units(ifc) == {
        "LENGTHUNIT": "mm",
        "AREAUNIT": "m²",
        "VOLUMEUNIT": "m³",
        "PLANEANGLEUNIT": "°",
        "MONETARYUNIT": "USD",
    }


def test_uses_last_assignment_when_project_reference_is_unavailable():
    ifc = b"""#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));"""

    assert extract_project_units(ifc) == {"LENGTHUNIT": "m"}


def test_returns_empty_mapping_without_unit_assignment():
    assert extract_project_units(b"ISO-10303-21;END-ISO-10303-21;") == {}
