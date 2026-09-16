"""Topology parsing, pinned against the four schema quirks seen in real exports.

Every fixture here reproduces something observed in shipped fleet metadata, not
something imagined. If a future export breaks one of these, peer-relative
detection silently loses coverage on that plant, which is exactly the kind of
quiet degradation that is hard to notice in production.
"""

from __future__ import annotations

import pytest

from nuravolt.fault.topology import (
    NAMEPLATE_CLASS_TOLERANCE,
    DeviceMeta,
    parse_component_meta,
)

HEADER = ("plantId;plantName;componentName;componentLabel;componentType;"
          "componentTypeGroup;Bus;Installed P_DC;Location;Network Address;"
          "Nominal P_AC;Serial;source")


def _row(name, bus="1.1", kwp="78.65", model="SUN 2000 - 60 KTL", loc="H.001 E"):
    return f"00461;Alpha1 (ES);{name};{name};{model};Inverter;{bus};{kwp};{loc};1;60;SN{name};nA"


def _csv(rows):
    return "\n".join([HEADER, *rows])


class TestSchemaQuirks:
    def test_na_bus_sentinel_becomes_none_not_a_bus_named_na(self):
        """Quirk 1: Gamma records 9 of 45 inverters with Bus='nA'."""
        topo = parse_component_meta(_csv([
            _row("INV 01.001", bus="1.1"),
            _row("INV 01.002", bus="nA"),
        ]), "gamma")
        assert topo.devices["INV 01.001"].bus == "1.1"
        assert topo.devices["INV 01.002"].bus is None
        assert "nA" not in topo.buses(), "the sentinel must not become a bus named 'nA'"

    def test_missing_bus_column_degrades_instead_of_raising(self):
        """Quirk 2: Epsilon's metadata has a different schema with no Bus column."""
        header = "plantId;plantName;componentName;componentType;componentTypeGroup;Installed P_DC;maStRNo;project"
        text = "\n".join([header,
                          "48;Epsilon;INV 1;Sunny Central 900 CP XT;Inverter;1036.8;X;p",
                          "48;Epsilon;INV 2;Sunny Central 900 CP XT;Inverter;1082.9;Y;p"])
        topo = parse_component_meta(text, "epsilon")
        assert topo.has_bus_column is False
        assert len(topo) == 2
        assert topo.buses() == {}
        # Plant-level grouping must still work.
        assert len(topo.peer_groups("inverter_within_plant")) == 1

    def test_utf8_bom_on_header_is_stripped(self):
        """Quirk 3: all_plants_meta.csv carries a BOM, making col 1 '\\ufeffplantName'."""
        topo = parse_component_meta("﻿" + _csv([_row("INV 01.001")]), "alpha")
        assert "INV 01.001" in topo.devices

    def test_blank_nameplate_excludes_the_device_rather_than_defaulting(self):
        """Quirk 4: a device with no Installed P_DC cannot be normalised."""
        topo = parse_component_meta(_csv([
            _row("INV 01.001", kwp="78.65"),
            _row("INV 01.002", kwp=""),
        ]), "x")
        assert topo.devices["INV 01.002"].kwp_dc is None
        assert topo.devices["INV 01.002"].is_groupable is False
        grouped = {d for members in topo.peer_groups().values() for d in members}
        assert "INV 01.002" not in grouped


class TestNameplateClassing:
    def test_near_identical_centrals_form_one_class(self):
        """Epsilon's 1,036 to 1,140 kWp centrals are one machine class, not eighteen."""
        rows = [_row(f"INV {i}", kwp=str(k), model="Sunny Central 900 CP XT")
                for i, k in enumerate([1036.8, 1070.2, 1082.9, 1099.8, 1129.0, 1140.7])]
        topo = parse_component_meta(_csv(rows), "epsilon")
        classes = {d.nameplate_class for d in topo.devices.values()}
        assert len(classes) == 1, f"expected one class, got {classes}"

    def test_genuinely_different_machines_are_separated(self):
        """Gamma's 238 kWp devices are a different machine from its 77 and 84 kWp."""
        rows = ([_row(f"S{i}", kwp="77.44") for i in range(3)]
                + [_row(f"M{i}", kwp="84.48") for i in range(3)]
                + [_row(f"L{i}", kwp="238.08") for i in range(3)])
        topo = parse_component_meta(_csv(rows), "gamma")
        by_class = {}
        for d in topo.devices.values():
            by_class.setdefault(d.nameplate_class, set()).add(round(d.kwp_dc))
        assert len(by_class) == 2, f"expected 2 classes, got {by_class}"
        big = [k for k, v in by_class.items() if 238 in v][0]
        assert by_class[big] == {238}, "the 238 kWp devices must not share a class"

    def test_tolerance_boundary_is_respected(self):
        just_inside = 100.0 * (1.0 + NAMEPLATE_CLASS_TOLERANCE * 0.9)
        just_outside = 100.0 * (1.0 + NAMEPLATE_CLASS_TOLERANCE * 1.1)
        inside = parse_component_meta(
            _csv([_row("A", kwp="100.0"), _row("B", kwp=str(just_inside))]), "x")
        outside = parse_component_meta(
            _csv([_row("A", kwp="100.0"), _row("B", kwp=str(just_outside))]), "x")
        assert len({d.nameplate_class for d in inside.devices.values()}) == 1
        assert len({d.nameplate_class for d in outside.devices.values()}) == 2


class TestPeerGrouping:
    def test_small_bus_groups_fall_back_to_plant_level(self):
        """A bus with too few members must not silently lose its devices."""
        rows = ([_row(f"A{i}", bus="1.1") for i in range(6)]
                + [_row(f"B{i}", bus="1.2") for i in range(2)])
        topo = parse_component_meta(_csv(rows), "x")
        usable = topo.usable_peer_groups("inverter_within_bus", min_members=4)
        covered = {d for g in usable.values() for d in g.scored}
        assert len(covered) == 8, "the 2-device bus should regroup at plant level"

    def test_every_device_is_scored_exactly_once(self):
        """Overlapping populations must not mean overlapping alerts."""
        rows = ([_row(f"A{i}", bus="1.1") for i in range(6)]
                + [_row(f"B{i}", bus="1.2") for i in range(2)])
        topo = parse_component_meta(_csv(rows), "x")
        usable = topo.usable_peer_groups("inverter_within_bus", min_members=4)
        scored = [d for g in usable.values() for d in g.scored]
        assert len(scored) == len(set(scored)), (
            f"a device is scored in more than one group: {scored}"
        )
        # The orphan group borrows the wider population for its baseline.
        orphan = next(g for g in usable.values() if set(g.scored) == {"B0", "B1"})
        assert len(orphan.population) == 8, "orphans must borrow the plant-wide class"
        assert len(orphan.scored) == 2

    def test_groups_below_the_floor_are_dropped_not_scored(self):
        """Three devices cannot support a robust dispersion estimate."""
        topo = parse_component_meta(_csv([_row(f"A{i}") for i in range(3)]), "x")
        assert topo.usable_peer_groups(min_members=4) == {}

    def test_unknown_level_is_rejected(self):
        topo = parse_component_meta(_csv([_row("A")]), "x")
        with pytest.raises(ValueError, match="unknown peer level"):
            topo.peer_groups("string_within_galaxy")
