from ifx import IFCViewer

viewer = IFCViewer("building.ifc", title="Building model", quality="medium")
viewer.color_by_type("IfcSpace", "#4f8cff66")
viewer.color_by_type(["IfcWall", "IfcWallStandardCase"], "#d8dde5")
viewer.view(block=True)
