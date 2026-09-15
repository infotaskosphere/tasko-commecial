"""Deterministic inventory and fixed-asset accounting primitives for Finix."""
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, Iterable
PAISE=Decimal("0.01")
QTY=Decimal("0.0001")

def _money(value:Any)->Decimal:
    amount=Decimal(str(value or 0))
    if not amount.is_finite():raise ValueError("Amount must be finite.")
    return amount.quantize(PAISE,rounding=ROUND_HALF_UP)

def _qty(value:Any)->Decimal:
    amount=Decimal(str(value or 0))
    if not amount.is_finite():raise ValueError("Quantity must be finite.")
    return amount.quantize(QTY,rounding=ROUND_HALF_UP)

def calculate_inventory_movement(qty:Any,unit_cost:Any,movement_type:str)->Dict[str,Any]:
    quantity=_qty(qty);cost=_money(unit_cost);movement=str(movement_type or "").upper()
    if quantity<=0 or cost<0:raise ValueError("Inventory quantity must be positive and unit cost cannot be negative.")
    if movement not in {"IN","OUT","ADJUSTMENT"}:raise ValueError("Unsupported inventory movement type.")
    signed=quantity if movement!="OUT" else -quantity
    return {"movement_type":movement,"quantity":float(quantity),"signed_quantity":float(signed),"unit_cost":float(cost),"value":float((quantity*cost).quantize(PAISE,rounding=ROUND_HALF_UP))}

def weighted_average_cost(opening_qty:Any,opening_value:Any,movements:Iterable[Dict[str,Any]])->Dict[str,float]:
    qty=_qty(opening_qty);value=_money(opening_value)
    if qty<0 or value<0:raise ValueError("Opening inventory cannot be negative.")
    for m in movements:
        movement=str(m.get("movement_type") or "").upper();q=_qty(m.get("quantity"));v=_money(m.get("value"))
        if q<=0 or v<0:raise ValueError("Inventory movement quantity/value is invalid.")
        if movement=="IN":qty+=q;value+=v
        elif movement=="OUT":
            if q>qty:raise ValueError("Inventory issue exceeds available quantity.")
            avg=value/qty if qty else Decimal("0");value=max(Decimal("0"),value-(avg*q));qty-=q
        elif movement=="ADJUSTMENT":value=v;qty=q
        else:raise ValueError("Unsupported inventory movement type.")
    avg=(value/qty).quantize(PAISE,rounding=ROUND_HALF_UP) if qty else Decimal("0.00")
    return {"closing_quantity":float(qty),"closing_value":float(value.quantize(PAISE,rounding=ROUND_HALF_UP)),"weighted_average_cost":float(avg)}

def straight_line_depreciation(cost:Any,residual_value:Any,useful_life_years:int,months:int=12)->Dict[str,float]:
    gross=_money(cost);residual=_money(residual_value);years=int(useful_life_years);months=int(months)
    if gross<=0 or residual<0 or residual>=gross or years<=0:raise ValueError("Invalid fixed-asset depreciation inputs.")
    if months<=0 or months>12:raise ValueError("Depreciation months must be between 1 and 12.")
    monthly=(gross-residual)/Decimal(years*12);charge=min(monthly*months,gross-residual)
    return {"annual_depreciation":float((monthly*12).quantize(PAISE,rounding=ROUND_HALF_UP)),"monthly_depreciation":float(monthly.quantize(PAISE,rounding=ROUND_HALF_UP)),"period_depreciation":float(charge.quantize(PAISE,rounding=ROUND_HALF_UP))}

def fixed_asset_register_record(asset_id:str,company_id:str,name:str,acquisition_date:Any,cost:Any,residual_value:Any,useful_life_years:int)->Dict[str,Any]:
    if not asset_id or not company_id or not name or not name.strip():raise ValueError("Asset identity is required.")
    if isinstance(acquisition_date,str):acquisition_date=date.fromisoformat(acquisition_date[:10])
    if not isinstance(acquisition_date,date):raise ValueError("Valid acquisition date is required.")
    depreciation=straight_line_depreciation(cost,residual_value,useful_life_years)
    return {"asset_id":asset_id,"company_id":company_id,"name":name.strip(),"acquisition_date":acquisition_date.isoformat(),"cost":float(_money(cost)),"residual_value":float(_money(residual_value)),"useful_life_years":int(useful_life_years),"depreciation":depreciation,"status":"ACTIVE"}
