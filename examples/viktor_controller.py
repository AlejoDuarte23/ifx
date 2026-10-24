import viktor as vkt

from ifx import IFCViewer


class Parametrization(vkt.Parametrization):
    ifc_file = vkt.FileField("IFC file", file_types=[".ifc"])


class Controller(vkt.Controller):
    parametrization = Parametrization

    @vkt.WebView("IFC viewer", duration_guess=10)
    def get_ifc_view(self, params, **kwargs):
        if not params.ifc_file:
            return vkt.WebResult(html="<p>Upload an IFC file to open the viewer.</p>")

        ifc_bytes = params.ifc_file.file.getvalue_binary()
        viewer = IFCViewer.from_bytes(
            ifc_bytes,
            filename="uploaded.ifc",
            quality="medium",
        )
        viewer.color_by_type("IfcSpace", "#4f8cff66")
        return viewer.viktor_result(asset_mode="bundle")
