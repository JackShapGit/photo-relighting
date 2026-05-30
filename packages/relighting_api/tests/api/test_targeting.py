from relighting_api.schemas import LightModel


def test_lightmodel_target_passthrough_to_engine() -> None:
    m = LightModel(type="spotlight", position=[0.5, 0.4, -0.3], target=[0.1, 0.2, -2.0])
    eng = m.to_engine()
    assert eng.target == (0.1, 0.2, -2.0)


def test_lightmodel_target_defaults_none() -> None:
    m = LightModel(type="spotlight")
    assert m.target is None
    assert m.to_engine().target is None
